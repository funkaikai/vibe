use super::AbortListener;
use crate::cmd::{transcribe::TranscribeOptions, ui::set_progress_bar, CommandError};
use crate::transcript::{Segment, Transcript};
use eyre::{Context, Result};
use once_cell::sync::Lazy;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};
use tauri::Emitter;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::Mutex;

const SAMPLE_RATE: u32 = 16_000;
const CHUNK_SAMPLES: usize = SAMPLE_RATE as usize * 20;
const MAX_AUDIO_SECONDS: u32 = 24 * 60 * 60;
const PROCESS_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const OUTPUT_LIMIT: usize = 256 * 1024;
static TRANSCRIBE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

fn command_error(code: &str, message: impl Into<String>) -> CommandError {
    CommandError {
        code: code.into(),
        message: message.into(),
    }
}

fn cancelled() -> CommandError {
    command_error("cancelled", "转写已取消")
}

pub async fn transcribe(
    app_handle: tauri::AppHandle,
    options: TranscribeOptions,
    model_path: PathBuf,
) -> Result<Transcript, CommandError> {
    let _lock = TRANSCRIBE_LOCK
        .try_lock()
        .map_err(|_| command_error("invalid_request", "已有 Qwen 转写任务正在运行"))?;
    if options.translate.unwrap_or(false) {
        return Err(command_error("invalid_request", "Qwen3-ASR 不支持翻译"));
    }
    if !matches!(options.lang.as_deref(), None | Some("zh") | Some("auto") | Some("")) {
        return Err(command_error("invalid_request", "当前 Qwen 引擎仅支持中文或自动识别"));
    }
    let binary = super::resolve_binary(&app_handle)?;
    let ffmpeg = crate::cmd::server_cmd::resolve_ffmpeg_path(&app_handle)
        .or_else(crate::ffmpeg::find_ffmpeg_path)
        .ok_or_else(|| command_error("internal_error", "未找到 FFmpeg"))?;
    if !Path::new(&options.path).is_file() {
        return Err(command_error("invalid_request", "音视频文件不存在或不是普通文件"));
    }

    let aborted = Arc::new(AtomicBool::new(false));
    let _listener = AbortListener::new(&app_handle, "abort_transcribe", aborted.clone());
    let started = Instant::now();
    let _ = set_progress_bar(&app_handle, Some(0.0));
    let result = transcribe_media(
        &options,
        &model_path,
        &binary,
        &ffmpeg,
        aborted,
        |segment| {
            app_handle.emit_to("main", "new_segment", segment).ok();
        },
        |progress| {
            let _ = set_progress_bar(&app_handle, Some(progress));
        },
    )
    .await;
    let _ = set_progress_bar(&app_handle, None);
    result.map(|segments| Transcript {
        processing_time_sec: started.elapsed().as_secs(),
        segments,
    })
}

async fn transcribe_media(
    options: &TranscribeOptions,
    model_path: &Path,
    binary: &Path,
    ffmpeg: &Path,
    aborted: Arc<AtomicBool>,
    mut on_segment: impl FnMut(Segment),
    mut on_progress: impl FnMut(f64),
) -> Result<Vec<Segment>, CommandError> {
    let temporary = tempfile::tempdir().context("无法创建 Qwen 临时音频目录")?;
    let decoded = temporary.path().join("decoded.wav");
    let mut conversion = conversion_command(ffmpeg, Path::new(&options.path), &decoded);
    if let Err(mut error) = run_command(&mut conversion, aborted.clone()).await {
        if error.code != "cancelled" {
            error.code = "invalid_audio".into();
            error.message = format!("无法读取音视频中的音轨：{}", error.message);
        }
        return Err(error);
    }
    let mut audio = hound::WavReader::open(&decoded).context("无法读取转换后的音频")?;
    let spec = audio.spec();
    if spec.channels != 1 || spec.sample_rate != SAMPLE_RATE || spec.bits_per_sample != 16 {
        return Err(command_error("invalid_audio", "转换后的音频格式不正确"));
    }
    let total = audio.duration() as usize;
    if total == 0 {
        return Err(command_error("invalid_audio", "音轨为空"));
    }
    if total as u64 >= u64::from(MAX_AUDIO_SECONDS) * u64::from(SAMPLE_RATE) {
        return Err(command_error("invalid_audio", "当前 Qwen 引擎最多支持 24 小时的单个音视频"));
    }

    let mut segments = Vec::new();
    let mut offset = 0usize;
    let mut samples = audio.samples::<i16>();
    while offset < total {
        if aborted.load(Ordering::Acquire) {
            return Err(cancelled());
        }
        let chunk: Vec<i16> = samples
            .by_ref()
            .take(CHUNK_SAMPLES)
            .collect::<std::result::Result<_, _>>()
            .context("无法读取音频分段")?;
        if chunk.is_empty() {
            return Err(command_error("invalid_audio", "音轨在读取完成前意外结束"));
        }
        let chunk_path = temporary.path().join("chunk.wav");
        write_chunk(&chunk_path, &chunk)?;
        let mut inference = Command::new(binary);
        inference.arg("--silent").arg("-d").arg(model_path).arg("-i").arg(&chunk_path);
        if options.lang.as_deref() != Some("auto") {
            inference.args(["--language", "Chinese"]);
        }
        if let Some(prompt) = options.init_prompt.as_deref().filter(|prompt| !prompt.is_empty()) {
            inference.arg("--prompt").arg(prompt);
        }
        let output = run_command(&mut inference, aborted.clone()).await?;
        let text = String::from_utf8(output).map_err(|_| command_error("internal_error", "Qwen 引擎返回了无效文本编码"))?;
        let end = offset + chunk.len();
        if !text.trim().is_empty() {
            let segment = Segment {
                start: (offset as u64 * 100 / u64::from(SAMPLE_RATE)) as i64,
                stop: (end as u64 * 100).div_ceil(u64::from(SAMPLE_RATE)) as i64,
                text: text.trim().into(),
                speaker: None,
            };
            on_segment(segment.clone());
            segments.push(segment);
        }
        offset = end;
        on_progress(offset as f64 * 100.0 / total as f64);
    }
    if aborted.load(Ordering::Acquire) {
        return Err(cancelled());
    }
    Ok(segments)
}

fn conversion_command(ffmpeg: &Path, source: &Path, output: &Path) -> Command {
    let mut command = Command::new(ffmpeg);
    command
        .args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i"])
        .arg(source)
        .args(["-map", "0:a:0", "-vn", "-t"])
        .arg((MAX_AUDIO_SECONDS + 1).to_string())
        .args(["-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le"])
        .arg(output);
    command
}

fn write_chunk(path: &Path, samples: &[i16]) -> Result<()> {
    let mut writer = hound::WavWriter::create(
        path,
        hound::WavSpec {
            channels: 1,
            sample_rate: SAMPLE_RATE,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        },
    )?;
    for sample in samples {
        writer.write_sample(*sample)?;
    }
    writer.finalize()?;
    Ok(())
}

async fn wait_for_abort(aborted: Arc<AtomicBool>) {
    while !aborted.load(Ordering::Acquire) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

// Keep draining both pipes even after their retained output reaches the cap, so a child cannot
// deadlock against a full stderr pipe. The temporary decoder and model processes are reaped below.
async fn read_output(mut reader: impl AsyncRead + Unpin) -> std::io::Result<(Vec<u8>, bool)> {
    let mut retained = Vec::new();
    let mut exceeded = false;
    let mut buffer = [0u8; 8192];
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        let keep = count.min(OUTPUT_LIMIT.saturating_sub(retained.len()));
        retained.extend_from_slice(&buffer[..keep]);
        exceeded |= keep < count;
    }
    Ok((retained, exceeded))
}

async fn run_command(command: &mut Command, aborted: Arc<AtomicBool>) -> Result<Vec<u8>, CommandError> {
    if aborted.load(Ordering::Acquire) {
        return Err(cancelled());
    }
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("无法启动本地音频处理进程")?;
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let stdout_task = tokio::spawn(read_output(stdout));
    let stderr_task = tokio::spawn(read_output(stderr));
    let status = tokio::select! {
        status = child.wait() => status.context("等待音频处理进程失败").map_err(CommandError::from),
        _ = wait_for_abort(aborted.clone()) => Err(cancelled()),
        _ = tokio::time::sleep(PROCESS_TIMEOUT) => Err(command_error("internal_error", "本地音频处理超时")),
    };
    if status.is_err() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    let stdout = stdout_task
        .await
        .context("读取引擎输出任务失败")?
        .context("无法读取引擎输出")?;
    let stderr = stderr_task
        .await
        .context("读取引擎错误任务失败")?
        .context("无法读取引擎错误输出")?;
    let status = status?;
    if aborted.load(Ordering::Acquire) {
        return Err(cancelled());
    }
    if !status.success() {
        let diagnostic = String::from_utf8_lossy(&stderr.0);
        return Err(command_error(
            "internal_error",
            format!("本地音频处理进程失败（{status}）：{}", diagnostic.trim()),
        ));
    }
    if stdout.1 {
        return Err(command_error("internal_error", "Qwen 引擎输出超出限制"));
    }
    Ok(stdout.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_a_bounded_standard_pcm_chunk() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("chunk.wav");
        write_chunk(&path, &[0, 1, -1, i16::MAX]).unwrap();
        let audio = hound::WavReader::open(path).unwrap();
        assert_eq!(audio.duration(), 4);
        assert_eq!(audio.spec().sample_rate, SAMPLE_RATE);
        assert_eq!(audio.spec().channels, 1);
    }

    #[tokio::test]
    async fn fails_for_process_errors_instead_of_returning_partial_text() {
        let mut command = Command::new("/usr/bin/false");
        let error = run_command(&mut command, Arc::new(AtomicBool::new(false))).await.unwrap_err();
        assert_eq!(error.code, "internal_error");
    }

    #[tokio::test]
    async fn cancellation_kills_and_reaps_a_running_process() {
        let aborted = Arc::new(AtomicBool::new(false));
        let signal = aborted.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            signal.store(true, Ordering::Release);
        });
        let started = Instant::now();
        let mut command = Command::new("/bin/sleep");
        command.arg("60");
        let error = run_command(&mut command, aborted).await.unwrap_err();
        assert_eq!(error.code, "cancelled");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn output_cap_does_not_deadlock_the_child() {
        let input = vec![b'a'; OUTPUT_LIMIT + 1];
        let (retained, exceeded) = read_output(input.as_slice()).await.unwrap();
        assert_eq!(retained.len(), OUTPUT_LIMIT);
        assert!(exceeded);
    }

    #[tokio::test]
    #[ignore = "requires the official 1.7B weights and a built qwen-asr sidecar"]
    async fn real_model_transcribes_media() {
        let model = PathBuf::from(std::env::var("VIBE_QWEN_TEST_MODEL_DIR").expect("model directory"));
        let binary = PathBuf::from(std::env::var("VIBE_QWEN_TEST_BINARY").expect("Qwen binary"));
        let ffmpeg = PathBuf::from(std::env::var("VIBE_QWEN_TEST_FFMPEG").expect("FFmpeg binary"));
        let audio = std::env::var("VIBE_QWEN_TEST_AUDIO").expect("audio or video fixture");
        super::super::model::validate(&model).unwrap();
        let options: TranscribeOptions = serde_json::from_value(serde_json::json!({"path": audio, "lang": "zh"})).unwrap();
        let mut observed = Vec::new();
        let mut progress = Vec::new();
        let segments = transcribe_media(
            &options,
            &model,
            &binary,
            &ffmpeg,
            Arc::new(AtomicBool::new(false)),
            |segment| observed.push(segment),
            |value| progress.push(value),
        )
        .await
        .unwrap();
        assert!(!segments.is_empty());
        assert_eq!(observed.len(), segments.len());
        assert_eq!(progress.last().copied(), Some(100.0));
        assert!(segments
            .iter()
            .all(|segment| segment.stop > segment.start && !segment.text.is_empty()));
        assert!(segments.windows(2).all(|pair| pair[0].stop <= pair[1].start));
        let text = segments.iter().map(|segment| segment.text.as_str()).collect::<String>();
        if let Ok(expected) = std::env::var("VIBE_QWEN_TEST_EXPECT") {
            assert!(text.contains(&expected), "transcript did not contain expected text: {text}");
        }
        println!("{}", serde_json::to_string(&segments).unwrap());
    }
}
