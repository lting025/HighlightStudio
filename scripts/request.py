"""Read one collaborator request. Only aggregate time-window counts are published."""
import base64
import gzip
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.request


def main():
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    issue = event["issue"]
    match = re.fullmatch(r"Highlight Studio · ([a-zA-Z0-9_-]{11}) · ([a-f0-9]{16})", issue["title"])
    if not match or issue["author_association"] not in {"OWNER", "MEMBER", "COLLABORATOR"}:
        return
    video_id = match[1]
    repo = os.environ["GITHUB_REPOSITORY"]
    number = int(issue["number"])
    api = f"https://api.github.com/repos/{repo}/issues/{number}"
    owner, project = repo.split("/")
    site = f"https://{owner}.github.io/{project}/?issue={number}"
    run = os.environ["GITHUB_RUN_ID"] + "-" + os.environ["GITHUB_RUN_ATTEMPT"]

    def send(method, suffix, payload):
        req = urllib.request.Request(api + suffix, json.dumps(payload).encode(), method=method,
              headers={"Authorization": "Bearer " + os.environ["GH_TOKEN"], "Content-Type": "application/json",
                       "User-Agent": "HighlightStudio"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            resp.read()

    def comment(body):
        send("POST", "/comments", {"body":body})

    with tempfile.TemporaryDirectory() as tmp:
        target = Path(tmp)
        output = target / "report.json"
        # The downloader and summarizer only receive the environment needed to run.
        env = {key:os.environ[key] for key in ("PATH","HOME","LANG") if key in os.environ}
        try:
            subprocess.run(["yt-dlp","--ignore-config","--no-playlist","--skip-download","--write-info-json",
                "--write-subs","--sub-langs","live_chat","--sub-format","json","--match-filter","live_status = was_live",
                "--no-progress","--retries","2","--socket-timeout","20","--js-runtimes","node",
                "-o",str(target / "video.%(ext)s"),"--","https://www.youtube.com/watch?v=" + video_id],
                env=env, check=True, timeout=1100)
            subprocess.run(["node","scripts/summary.cjs",tmp,video_id,str(output)], env=env, check=True, timeout=210)
            encoded = base64.b64encode(gzip.compress(output.read_bytes())).decode("ascii")
            parts = [encoded[i:i+46000] for i in range(0,len(encoded),46000)]
            if len(parts) > 30:
                raise ValueError("stats too large")
        except (subprocess.SubprocessError, OSError, ValueError):
            comment("HS-ERROR/1\n\n這次未能完成。請確認直播已結束且能開啟聊天室重播。YouTube 拒絕 GitHub 的請求、處理逾時或紀錄過大也可能造成失敗。")
            send("PATCH", "", {"state":"closed"})
            raise
        for index, part in enumerate(parts):
            comment(f"<!-- HS-DATA/1 {run} {index}\n{part}\n-->\n時段統計 {index+1}/{len(parts)}")
        comment(f"<!-- HS-DONE/1 {run} {len(parts)} -->\n[開啟聊天室分析結果]({site})")
        send("PATCH", "", {"state":"closed"})


if __name__ == "__main__":
    main()
