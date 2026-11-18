"""Single-worker WSGI service for one operator, with short-lived async jobs."""
import hmac
import json
import os
import re
import shutil
import tempfile
import threading
import time
import uuid
from http import HTTPStatus
from pathlib import Path
from urllib.parse import urlsplit
from wsgiref.util import FileWrapper

from media import process

ORIGIN = os.environ['PAGES_ORIGIN'].strip().rstrip('/')
SECRET = os.environ['STUDIO_KEY'].strip()
if len(SECRET) < 32 or not SECRET.isascii() or not SECRET.isprintable():
    raise ValueError('STUDIO_KEY needs at least 32 printable ASCII characters')
if urlsplit(ORIGIN).scheme != 'https' or not urlsplit(ORIGIN).hostname or urlsplit(ORIGIN).path or '?' in ORIGIN or '#' in ORIGIN:
    raise ValueError('PAGES_ORIGIN must be an HTTPS origin without a path')

scratch = tempfile.TemporaryDirectory(prefix='highlight-cloud-')
root = Path(scratch.name)
jobs = {}
lock = threading.RLock()
FILES = {'chat': ('video.live_chat.json', 'application/x-ndjson'), 'mp4': ('clip.mp4', 'video/mp4'),
         'srt': ('clip.srt', 'application/x-subrip; charset=utf-8')}


def prune(reserve=False):
    finished = sorted((j['finished'], key) for key, j in jobs.items() if 'finished' in j)
    for i, (done, key) in enumerate(finished):
        if time.monotonic() - done > 3600 or (reserve and len(finished) - i >= 5):
            del jobs[key]
            shutil.rmtree(root / key, ignore_errors=True)


def execute(key, data):
    folder = root / key
    def stage(text):
        with lock:
            jobs[key]['stage'] = text
    try:
        folder.mkdir()
        result = process(data, folder, stage)
        keep = {FILES[name][0] for name in result['files']}
        for path in folder.iterdir():
            if path.is_file() and path.name not in keep:
                path.unlink()
        outcome = {'state': 'done', **result}
    except Exception as exc:
        shutil.rmtree(folder, ignore_errors=True)
        outcome = {'state': 'error', 'error': str(exc) if isinstance(exc, ValueError) else '工作失敗，請檢查後端資源並重試。'}
    with lock:
        jobs[key].update(outcome, finished=time.monotonic())


def validate(data):
    if (not isinstance(data, dict) or not isinstance(data.get('id'), str)
            or not re.fullmatch(r'[A-Za-z0-9_-]{11}', data['id'])):
        raise ValueError('YouTube 影片 ID 格式不正確。')
    if data.get('kind') not in ('chat', 'clip', 'subtitles'):
        raise ValueError('不支援的工作種類。')
    if data['kind'] != 'chat':
        a, b = data.get('start'), data.get('end')
        if not all(type(x) in (int, float) and 0 <= x <= 7*86400 for x in (a, b)) or not 0 < b-a <= 600:
            raise ValueError('片段長度須大於零且最多十分鐘。')
    return data


def app(env, start_response):
    method, path = env['REQUEST_METHOD'], env['PATH_INFO']
    origin = env.get('HTTP_ORIGIN', '')
    headers = [('Cache-Control', 'no-store'), ('Vary', 'Origin'), ('X-Content-Type-Options', 'nosniff')]
    if origin == ORIGIN:
        headers += [('Access-Control-Allow-Origin', ORIGIN),
                    ('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'),
                    ('Access-Control-Allow-Headers', 'Authorization, Content-Type')]
    def reply(code, values):
        body = json.dumps(values, ensure_ascii=False).encode()
        start_response(f'{code} {HTTPStatus(code).phrase}', headers + [('Content-Type', 'application/json; charset=utf-8'),
                       ('Content-Length', str(len(body)))])
        return [body]
    if path == '/healthz' and method == 'GET':
        return reply(200, {'ok': True})
    if origin and origin != ORIGIN:
        return reply(403, {'error': '這個網站來源未獲准。'})
    if method == 'OPTIONS':
        return reply(200, {})
    if not hmac.compare_digest(env.get('HTTP_AUTHORIZATION', '').encode(), ('Bearer '+SECRET).encode()):
        return reply(401, {'error': '連線金鑰不正確。'})
    if method == 'GET' and path == '/api/status':
        return reply(200, {'ok': True})
    if method == 'POST' and path == '/api/jobs':
        try:
            size = int(env.get('CONTENT_LENGTH') or 0)
            if not 0 < size <= 4096:
                raise ValueError('工作要求過大或缺少內容。')
            data = validate(json.loads(env['wsgi.input'].read(size)))
        except (ValueError, TypeError):
            return reply(400, {'error': '工作資料有誤。請確認影片及片段範圍，單段上限十分鐘。'})
        with lock:
            if any(j['state'] == 'running' for j in jobs.values()):
                return reply(409, {'error': '後端正在處理另一個工作，請稍後再試。'})
            prune(reserve=True)
            key = uuid.uuid4().hex
            jobs[key] = {'state': 'running', 'stage': '準備中'}
            threading.Thread(target=execute, args=(key, data), daemon=True).start()
            return reply(202, {'job': key})
    found = re.fullmatch(r'/api/jobs/([0-9a-f]{32})(?:/(chat|mp4|srt))?', path)
    if method != 'GET' or not found:
        return reply(404, {'error': '找不到 API。'})
    key, item = found.groups()
    with lock:
        prune()
        job = jobs.get(key)
        if not job:
            return reply(404, {'error': '工作已過期或後端已重新啟動，請重新送出。'})
        if not item:
            return reply(200, {k:v for k,v in job.items() if k != 'finished'})
        if item not in job.get('files', []):
            return reply(404, {'error': '結果尚未產生。'})
        filename, mime = FILES[item]
        file = (root / key / filename).open('rb')
    start_response('200 OK', headers + [('Content-Type', mime), ('Content-Length', str(os.fstat(file.fileno()).st_size))])
    return FileWrapper(file, 65536)


def clean_periodically():
    while True:
        time.sleep(60)
        with lock:
            prune()

threading.Thread(target=clean_periodically, daemon=True).start()
