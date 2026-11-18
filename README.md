# 拾刻｜GitHub Pages ＋ Render 部署版

開啟網站即可讀取一場公開 YouTube 直播的聊天室重播，調整精華評分，並對選中的片段產生 MP4 或 MP4＋SRT。GitHub Pages 在瀏覽器執行聊天室分析。Render 執行 yt-dlp、FFmpeg 和多語言 faster-whisper tiny。適合自己使用或少數共用同一金鑰的人。

## 1. 上傳專案到 GitHub

建立一個 repository，例如 `highlight-studio`。完整解壓縮本套件，把其中的 `docs/`、`backend/`、`Dockerfile`、`README.md` 及附帶的設定檔放到儲存庫根目錄並 commit。從 GitHub 網頁上傳時，可把解壓縮後的檔案與兩個子資料夾一起拖進 **Add file → Upload files**。確認首頁直接看得到 `Dockerfile`，並能開啟 `docs/index.html`。本套件已包含前端與後端所需程式，原本的 Windows ZIP 可以留在電腦上。

## 2. 打開 GitHub Pages

在儲存庫進入 **Settings → Pages → Build and deployment**。選 **Deploy from a branch**，指定 `main` 和 `/docs`，按 **Save**。若預設分支名稱不同，選實際分支。若使用 GitHub Free，這個做法可使用公開儲存庫。

假設帳號為 `lting025`，儲存庫叫 `highlight-studio`，預設網站網址為 `https://lting025.github.io/highlight-studio/`。請以 Pages 顯示的實際網址為準。

## 3. 建立 Render 後端

1. 登入 Render Dashboard，選 **New → Web Service**，連接 GitHub，選擇這個 repository。
2. 選實際分支，**Language / Runtime** 選 **Docker**；**Root Directory** 留白，**Dockerfile Path** 使用根目錄的 `./Dockerfile`。容器已依 Render 提供的 PORT 監聽 0.0.0.0，不需自行填啟動命令。
3. 在 **Environment** 新增下表的兩個變數。**Health Check Path** 可設為 `/healthz`。服務採單一執行個體、單一 Gunicorn worker。
4. 選實例規格並檢查畫面上的費用，再建立服務。免費規格適合先檢查連線；字幕是否跑得完取決於可用記憶體及 CPU。若要處理字幕，先試短片段。出現記憶體不足時再調整規格。
5. 等服務狀態變成 **Live**。開啟自己的 `https://服務名稱.onrender.com/healthz`。看到 `{"ok": true}` 表示後端已啟動。這一步尚未測試 YouTube 或字幕模型。

| 變數名稱 | 值 |
|---|---|
| `PAGES_ORIGIN` | Pages 網址的協定與網域，例如 `https://lting025.github.io`。儲存庫路徑 `/highlight-studio/` 不用填。自訂網域則填該網站實際的 origin。 |
| `STUDIO_KEY` | 自行產生、至少 32 個可列印 ASCII 字元的隨機密鑰。可使用密碼管理器，或執行下方命令。這是工作台自訂的密鑰，無需申請 GitHub 或 Render API token。 |

在 Windows 電腦已裝 Python 時，可用這行產生密鑰，並保存在自己的密碼管理器：

```powershell
py -c "import secrets; print(secrets.token_urlsafe(32))"
```

## 4. 讓網頁呼叫後端

開啟 GitHub Pages 網站，在「連接雲端後端」填入 Render 的 HTTPS 網址和相同的 STUDIO_KEY，按「連線」。網址只填到網域結尾。連線金鑰在分頁記憶體中使用，重新整理後須重填。

如果想預填後端網址，在 GitHub 修改 `docs/config.js` 後 commit：

```js
window.STUDIO_API_URL = 'https://你的服務名稱.onrender.com';
```

此檔案會公開。金鑰只填在 Render 的 Environment 與自己的連線表單，請勿把金鑰、cookies.txt 或 .env 放進 GitHub。

## 5. 驗收整條流程

1. 網頁右上出現「雲端已連線」後，貼上有聊天室重播的公開直播存檔，按「讀取聊天室」。
2. 選一個有說話聲的短片段，按「產生 MP4＋SRT」。首次轉錄會下載多語言 tiny 模型。中文、日文等語言由模型自動判斷。
3. 到「完成的檔案」分別按「下載 MP4」和「下載 SRT」。字幕時間從剪輯片段開頭起算。若音檔沒有辨識出語音，仍可取得 MP4。
4. 保留此分頁直到下載完成。此個人版同時處理一項工作，單段最多十分鐘、最高 720p。工作結果保留最多一小時或最近五筆；服務重啟後須重跑。請將要保留的產出下載到自己的裝置。

## 前後端如何連線

瀏覽器直接呼叫 Render 的 HTTPS 網址。瀏覽器會先用 OPTIONS 檢查跨來源授權；後端允許指定的 PAGES_ORIGIN 使用 Authorization 和 Content-Type。後端另外驗證 `Authorization: Bearer <STUDIO_KEY>`，這樣只有知道密鑰的人可以開始工作或讀取結果。

| 路徑 | 用途 |
|---|---|
| `GET /healthz` | 公開健康檢查 |
| `GET /api/status` | 驗證連線金鑰 |
| `POST /api/jobs` | 以影片 ID 建立 chat、clip 或 subtitles 工作，回傳 HTTP 202 及 job 編號 |
| `GET /api/jobs/{job}` | 查詢工作進度、錯誤或可下載檔案 |
| `GET /api/jobs/{job}/{chat、mp4 或 srt}` | 取得所選檔案 |

## 常見問題

| 現象 | 檢查 |
|---|---|
| 後端網址開啟顯示錯誤 | 請開啟 /healthz；查看 Render 的部署狀態和 Logs。 |
| /healthz 正常，但前端連不到 | 在 Pages 頁面的瀏覽器主控台輸入 `location.origin`，將結果填入 Render 的 PAGES_ORIGIN 並套用。確認前端使用 Render 的 HTTPS 網址。 |
| 401 或提示金鑰錯誤 | 比對 Render 的 STUDIO_KEY 和工作台輸入值。 |
| 409 或提示正在處理 | 目前已有一筆任務執行中，等它完成後再送出。 |
| 讀不到聊天室 | 確認該存檔能播放且有聊天室重播。YouTube 可能限制雲端 IP，這時 HTTPS 與 CORS 可以都正常。已取得的聊天室檔仍可直接匯入。 |
| 模型載入失敗或服務重啟 | 查看 Render Logs 是否有記憶體不足或連不到模型來源。先測短片段；需要更多資源時再選相應實例。 |

[GitHub Pages 發布來源](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site) · [Render Docker](https://render.com/docs/docker) · [Render Web Services](https://render.com/docs/web-services) · [Render 免費實例限制](https://render.com/docs/free) · [faster-whisper](https://github.com/SYSTRAN/faster-whisper)
