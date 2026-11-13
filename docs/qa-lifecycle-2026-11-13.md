# 房間與線上人員生命週期驗證

日期：2026-11-13。環境：Windows、Node.js 22.23.2、Chromium（Playwright）。

- 根因：觀眾可以阻止關房或取消空房寬限；大廳半斷線仍留在 people 名冊；關房沒有通知觀眾或清除完整快照紀錄。
- 只有連線玩家可保留房間。等候房間斷線沿用 60 秒寬限，觀眾加入不延長；真人重新入座才取消。
- 主動離房及對局中零連線玩家立即關閉；邀請、輸入佇列、輸入序號與快照紀錄一併清理。
- 網路層超過 15 秒沒有任何 frame 時終止 socket，統一走既有離線與人數推送流程。正常瀏覽器 pong 可保活，不依賴頁面 JS 心跳。
- close/error/主動終止共用一次性清理，避免重複關閉事件。
- 觀眾收到 closed 後返回大廳，伺服器連線所屬房間也清空。

驗證：

- `npm test`：通過，含 5 項新增生命週期情境、237 項規則與 7 項 UI 資產檢查。
- `npm run verify`：全部通過，含 AI、多人協定、網路同步、音訊、結算及流暢度驗證。
- `npm run test:online`：65 項通過。原「兩人斷線仍為 result」斷言依零玩家關房規則更新為 closed，保留斷線判輸結果斷言。
- `node scripts/e2e-online.js --url=<本機測試服務> --shots=screenshots`：47 項通過，涵蓋三角色、完整對局、結算回房、手機與平板。
- `node scripts/lifecycle-browser.cjs`：三個獨立瀏覽器情境確認觀眾收到關房並返回大廳，無 pageerror。
- Playwright 由既有相鄰專案透過本機 NODE_PATH 提供，未增加遊戲依賴。
- 已檢視手機房間截圖；未執行所有既有畫面在每一尺寸與語系的完整排列。
- 無設定 formatter；手動依既有風格整理，`git diff --check` 通過。檔案採 UTF-8 無 BOM。

最後依 loop-engineering 檢視、修復、驗證一輪。未驗證正式服務部署結果；本機 Node 版本低於專案宣告的 26.12.1。
