"""YouTube replay/clip acquisition and clip-relative subtitles."""
import json
import os
import signal
import subprocess
import sys
from pathlib import Path


def run(args, directory, timeout):
    # Terminate the whole process group, including FFmpeg, on timeout.
    with (directory / 'process.log').open('w+b') as log:
        with subprocess.Popen(args, cwd=directory, stdout=subprocess.DEVNULL, stderr=log,
                              start_new_session=True) as child:
            try:
                code = child.wait(timeout)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
                raise ValueError('作業逾時。請縮短片段或稍後重試。')
        if code:
            log.seek(max(0, log.tell() - 4096))
            why = log.read().decode('utf-8', 'replace').lower()
            if 'sign in' in why or '403' in why or '429' in why:
                raise ValueError('YouTube 拒絕這台後端讀取影片，請換可讀取的公開直播存檔或匯入聊天室。')
            if 'audio' in why and 'stream' in why:
                raise ValueError('片段缺少可辨識的音軌。')
            raise ValueError('處理程序失敗。請確認影片及聊天室可用；產生字幕時也需足夠記憶體及模型下載連線。')


def process(data, directory, stage):
    url = 'https://www.youtube.com/watch?v=' + data['id']
    args = ['yt-dlp', '--ignore-config', '--no-playlist', '--no-cache-dir', '--no-progress',
            '--js-runtimes', 'node', '--socket-timeout', '25', '--retries', '2',
            '--match-filter', '!is_live']
    if data['kind'] == 'chat':
        stage('讀取聊天室')
        run(args + ['--skip-download', '--write-subs', '--sub-langs', 'live_chat', '--sub-format',
                    'json', '--write-info-json', '-o', 'video.%(ext)s', '--', url], directory, 1500)
        chat = directory / 'video.live_chat.json'
        if not chat.is_file() or not chat.stat().st_size:
            raise ValueError('這部影片沒有可讀取的聊天室重播。')
        if chat.stat().st_size > 128 * 1024**2:
            raise ValueError('聊天室超過此工作台支援的 128 MiB。')
        info = json.loads((directory / 'video.info.json').read_text(encoding='utf-8'))
        return {'title': str(info.get('title') or data['id'])[:300], 'duration': info.get('duration') or 0,
                'files': ['chat']}
    stage('下載並剪輯 MP4')
    run(args + ['--download-sections', f"*{data['start']}-{data['end']}", '--force-keyframes-at-cuts',
                '-f', 'bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720][ext=mp4]/b[height<=720]',
                '--merge-output-format', 'mp4', '--recode-video', 'mp4', '-o', 'clip.%(ext)s', '--', url],
        directory, 1200)
    clip = directory / 'clip.mp4'
    if not clip.is_file() or not clip.stat().st_size:
        raise ValueError('沒有取得影片。請使用已結束的直播存檔。')
    result = {'files': ['mp4']}
    if data['kind'] == 'subtitles':
        stage('Whisper 正在辨識語音')
        try:
            run([sys.executable, str(Path(__file__).resolve()), '--srt', str(clip)], directory, 1500)
            if (directory / 'clip.srt').stat().st_size:
                result['files'].append('srt')
            else:
                result['notice'] = '這段沒有辨識到語音，仍可下載 MP4。'
        except (ValueError, OSError) as exc:
            result['notice'] = '影片已完成，字幕未完成。' + str(exc)
    return result


def stamp(seconds):
    ms = max(0, round(seconds * 1000))
    sec, ms = divmod(ms, 1000)
    minute, sec = divmod(sec, 60)
    hour, minute = divmod(minute, 60)
    return f'{hour:02}:{minute:02}:{sec:02},{ms:03}'


def write_srt(segments, output):
    with output.open('w', encoding='utf-8') as out:
        n = 0
        for segment in segments:
            text = segment.text.strip()
            if text:
                n += 1
                out.write(f'{n}\n{stamp(segment.start)} --> {stamp(segment.end)}\n{text}\n\n')


if __name__ == '__main__':
    from faster_whisper import WhisperModel
    model = WhisperModel('tiny', device='cpu', compute_type='int8', cpu_threads=1)
    video = Path(sys.argv[2])
    speech, _ = model.transcribe(str(video), beam_size=1)
    write_srt(speech, video.with_suffix('.srt'))
