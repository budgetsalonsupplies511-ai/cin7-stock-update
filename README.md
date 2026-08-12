# Cin7 Omni Scanner Connector

This backend connects the scanner web app to Cin7 Omni. Keep it on Render so your Cin7 API username and key are not placed in the Netlify app.

## Render settings

Build command:

```text
npm install
```

Start command:

```text
npm start
```

Environment variables:

```text
CIN7_API_USERNAME=your Cin7 API username
CIN7_API_KEY=your Cin7 API key
CIN7_API_BASE_URL=https://api.cin7.com/api/v1
CIN7_STOCK_UPDATE_PIN=choose a private PIN
CIN7_BRANCH_TRANSFER_PIN=choose a private PIN for branch transfers
CIN7_STOCK_UPDATE_AUTO_APPROVE=true
CIN7_WRITE_TIMEOUT_MS=55000
CIN7_SEARCH_PAGE_LIMIT=100
CIN7_SEARCH_ROWS_PER_PAGE=100
CIN7_SEARCH_REQUEST_DELAY_MS=300
CIN7_RETRY_AFTER_MS=10000
ALLOWED_ORIGIN=*
```

`CIN7_STOCK_UPDATE_PIN` is required before the stocktake app can update Cin7 stock.

`CIN7_BRANCH_TRANSFER_PIN` is required before the combined app can create Cin7 branch transfers. If you do not add it, the backend will use `CIN7_STOCK_UPDATE_PIN`.

`CIN7_STOCK_UPDATE_AUTO_APPROVE=true` creates an approved adjustment. Set it to `false` if you want Cin7 to create draft adjustments for review instead.

After deploy, open:

```text
https://your-render-url.onrender.com/api/diagnostics
```

It should show `ok: true` and `hasUsername: true`, `hasApiKey: true`.
