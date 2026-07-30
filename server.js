import cors from "cors";
import dotenv from "dotenv";
import express from "express";

dotenv.config();

const app = express();
const connectorVersion = "2026-07-30-flex-name-search-v11-zero-stock-lookup";
const port = Number(process.env.PORT || 3000);
const cin7Username = process.env.CIN7_API_USERNAME || "";
const cin7ApiKey = process.env.CIN7_API_KEY || "";
const cin7BaseUrl = (process.env.CIN7_API_BASE_URL || "https://api.cin7.com/api/v1").replace(/\/+$/, "");
const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
const searchCacheMs = 10 * 60 * 1000;
const searchPageLimit = Number(process.env.CIN7_SEARCH_PAGE_LIMIT || 100);
const searchRowsPerPage = Number(process.env.CIN7_SEARCH_ROWS_PER_PAGE || 100);
const searchRequestDelayMs = Number(process.env.CIN7_SEARCH_REQUEST_DELAY_MS || 300);
const stockUpdatePin = process.env.CIN7_STOCK_UPDATE_PIN || "";
const stockUpdateAutoApprove = String(process.env.CIN7_STOCK_UPDATE_AUTO_APPROVE || "true").toLowerCase() !== "false";
const cin7WriteTimeoutMs = Number(process.env.CIN7_WRITE_TIMEOUT_MS || 55000);
let productSearchCache = { expiresAt: 0, rows: [] };
let productSearchWarmup = null;
const updateJobs = new Map();

app.use(cors({ origin: allowedOrigin === "*" ? true : allowedOrigin }));
app.use(express.json({ limit: "10mb" }));

app.get("/", (_req, res) => {
  res.json({ ok: true, app: "Scanner Cin7 Omni Connector", version: connectorVersion });
});

app.get("/api/diagnostics", (_req, res) => {
  res.json({
    ok: true,
    app: "Scanner Cin7 Omni Connector",
    version: connectorVersion,
    cin7BaseUrl,
    allowedOrigin,
    hasUsername: Boolean(cin7Username),
    hasApiKey: Boolean(cin7ApiKey),
    stockUpdateEnabled: Boolean(stockUpdatePin),
    stockUpdateAutoApprove,
    cin7WriteTimeoutMs,
    searchPageLimit,
    searchRowsPerPage,
    searchRequestDelayMs,
    searchCache: cacheStatus()
  });
});

app.get("/api/cache-status", (_req, res) => {
  res.json({ ok: true, ...cacheStatus() });
});

app.post("/api/warm-cache", async (_req, res) => {
  try {
    const rows = await warmProductCache();
    res.json({ ok: true, warmed: true, ...cacheStatus(), count: rows.length });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/locations", async (_req, res) => {
  try {
    const branches = await cin7Get("/Branches", {
      fields: "id,company,isActive",
      rows: "250"
    });

    const locations = asArray(branches)
      .filter((branch) => branch.isActive !== false)
      .map((branch) => ({
        id: String(branch.id ?? branch.Id ?? ""),
        name: String(branch.company ?? branch.Company ?? `Branch ${branch.id ?? branch.Id}`)
      }))
      .filter((branch) => branch.id);

    res.json(locations);
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/lookup", async (req, res) => {
  const code = String(req.query.code || "").trim();
  const branchId = String(req.query.locationId || "").trim();
  if (!code) return res.status(400).json({ error: "Missing barcode" });

  try {
    const lookup = await findStockRows(code);
    const stock = chooseStockRow(lookup.rows, code, branchId);
    if (!stock) return res.status(404).json({ error: "No Cin7 Omni product matched this barcode" });

    const productOptionId = stock.productOptionId ?? stock.ProductOptionId;
    const productId = stock.productId ?? stock.ProductId;
    const option = await getBestProductOption(productId, productOptionId, code);
    const product = productId ? await getProduct(productId) : null;
    const name = buildProductName(stock, option);
    const selectedBranchId = stock.branchId ?? stock.BranchId ?? "";
    const selectedBranchName = stock.branchName ?? stock.BranchName ?? "";
    const stockOnHand = stock.stockOnHand ?? stock.StockOnHand ?? stock.available ?? stock.Available ?? "";
    const priceTiers = mergePriceTiers(extractPriceTiers(option, option), extractPriceTiers(stock, stock));
    const imageUrl = imageUrlFrom(option, product, stock);

    res.json({
      barcode: stock.barcode ?? stock.Barcode ?? stock.productOptionBarcode ?? stock.ProductOptionBarcode ?? stock.productOptionSizeBarcode ?? stock.ProductOptionSizeBarcode ?? code,
      sku: stock.code ?? stock.Code ?? "",
      price: priceTiers.special || priceTiers.retail || "",
      priceSource: priceTiers.special ? "special" : "retail",
      priceTiers,
      imageUrl,
      productTitle: name,
      variantTitle: "",
      productId: productId ?? "",
      productOptionId: productOptionId || "",
      locationId: String(selectedBranchId),
      locationName: String(selectedBranchName),
      cin7Quantity: stockOnHand,
      matchType: lookup.matchType,
      cin7Stock: {
        available: stock.available ?? stock.Available ?? "",
        stockOnHand: stock.stockOnHand ?? stock.StockOnHand ?? "",
        openSales: stock.openSales ?? stock.OpenSales ?? "",
        incoming: stock.incoming ?? stock.Incoming ?? "",
        holding: stock.holding ?? stock.Holding ?? ""
      }
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/debug-lookup", async (req, res) => {
  const code = String(req.query.code || "").trim();
  if (!code) return res.status(400).json({ error: "Missing barcode" });

  try {
    const lookup = await findStockRows(code);
    res.json({
      code,
      version: connectorVersion,
      matchType: lookup.matchType,
      count: lookup.rows.length,
      rows: await Promise.all(lookup.rows.slice(0, 20).map(debugStockSummary))
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/search-products", async (req, res) => {
  const query = String(req.query.q || "").trim();
  if (query.length < 2) return res.status(400).json({ error: "Type at least 2 letters" });

  try {
    const rows = await searchProductsByName(query);
    res.json(rows.slice(0, 20));
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/image", async (req, res) => {
  const rawUrl = String(req.query.url || "").trim();
  const imageUrl = normaliseImageUrl(rawUrl);
  if (!imageUrl) return res.status(400).send("Missing image URL");

  try {
    const response = await fetch(imageUrl, {
      headers: {
        "Accept": "image/*,*/*",
        "Authorization": `Basic ${Buffer.from(`${cin7Username}:${cin7ApiKey}`).toString("base64")}`
      }
    });
    if (!response.ok) return res.status(response.status).send("Image could not be loaded");

    const contentType = response.headers.get("content-type") || "image/jpeg";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/debug-products", async (_req, res) => {
  try {
    const products = await fetchProductPages(1, 10, false);
    res.json({
      productCount: products.length,
      products: products.slice(0, 5).map((product) => ({
        id: product.id ?? product.Id ?? product.ID,
        name: product.name ?? product.Name ?? product.productName ?? product.ProductName ?? "",
        imageUrl: imageUrlFrom(product),
        imageKeys: imageKeys(product),
        optionCount: asArray(product.productOptions ?? product.ProductOptions ?? product.options ?? product.Options).length
      }))
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/debug-search", async (req, res) => {
  const query = String(req.query.q || "").trim();
  if (query.length < 2) return res.status(400).json({ error: "Type at least 2 letters" });

  try {
    const products = await getCachedProducts();
    const words = searchWords(query);
    const matches = products
      .filter((product) => matchesWords(searchTextForProduct(product), words))
      .slice(0, 10)
      .map((product) => ({
        id: product.id ?? product.Id ?? product.ID,
        name: product.name ?? product.Name ?? product.productName ?? product.ProductName ?? "",
        text: searchTextForProduct(product).slice(0, 240)
      }));

    res.json({
      ok: true,
      query,
      words,
      normalisedQuery: normaliseSearchText(query),
      productCount: products.length,
      matchCount: matches.length,
      matches
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/stocktake-adjustment", async (req, res) => {
  try {
    if (!stockUpdatePin) return res.status(403).json({ error: "Cin7 stock update is not enabled on this backend" });
    if (String(req.body.pin || "") !== stockUpdatePin) return res.status(401).json({ error: "Wrong update PIN" });

    const branchId = Number(req.body.branchId);
    const branchName = String(req.body.branchName || "");
    const items = asArray(req.body.items);
    if (!Number.isFinite(branchId) || branchId <= 0) return res.status(400).json({ error: "Missing Cin7 branch" });

    const parsedLines = await Promise.all(items.map((item, index) => stocktakeItemToAdjustmentLine(item, index, branchId)));
    const skippedLines = parsedLines.filter((line) => !line.ok).map((line) => line.reason);
    const lineItems = parsedLines
      .filter((line) => line.ok)
      .map((line) => line.line)
      .filter((line) => line.qty !== 0);

    if (!lineItems.length) {
      return res.status(400).json({
        error: "No valid stock differences to update",
        received: items.length,
        skipped: skippedLines.slice(0, 10),
        note: "A valid stock update needs Cin7 productOptionId, current stock, and counted stock. Counted 0 is valid when current stock is above 0."
      });
    }

    const jobId = stocktakeReference();
    const adjustment = {
      isApproved: stockUpdateAutoApprove,
      reference: jobId,
      branchId,
      completedDate: new Date().toISOString(),
      adjustmentReason: `Stocktake update${branchName ? ` - ${branchName}` : ""}`,
      source: "Stocktake app",
      lineItems
    };

    const job = {
      id: jobId,
      status: "queued",
      reference: jobId,
      branchId,
      branchName,
      approved: stockUpdateAutoApprove,
      lineCount: lineItems.length,
      adjustmentTotal: lineItems.reduce((total, line) => total + line.qty, 0),
      createdAt: new Date().toISOString(),
      completedAt: "",
      result: null,
      error: "",
      request: adjustment
    };
    updateJobs.set(jobId, job);
    runStockUpdateJob(jobId, adjustment);
    res.json({ ok: true, queued: true, jobId, ...job });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/stocktake-adjustment-status/:jobId", (req, res) => {
  const job = updateJobs.get(String(req.params.jobId || ""));
  if (!job) return res.status(404).json({ error: "Stock update job not found" });
  res.json({ ok: true, ...job });
});

app.get("/api/stocktake-adjustment-jobs", (_req, res) => {
  res.json({
    ok: true,
    jobs: [...updateJobs.values()].slice(-20).map((job) => ({
      id: job.id,
      status: job.status,
      reference: job.reference,
      branchId: job.branchId,
      branchName: job.branchName,
      lineCount: job.lineCount,
      adjustmentTotal: job.adjustmentTotal,
      createdAt: job.createdAt,
      completedAt: job.completedAt,
      error: job.error,
      result: job.result
    }))
  });
});

async function findStockRows(code) {
  const byBarcode = asArray(await cin7Get(`/Stock/${encodeURIComponent(code)}`));
  const exactBarcode = byBarcode.filter((row) => sameCode(barcodeValue(row), code));
  if (exactBarcode.length) return { matchType: "stock_barcode", rows: exactBarcode };
  if (byBarcode.length && !byBarcode.some(barcodeValue)) return { matchType: "stock_barcode_endpoint", rows: byBarcode };

  const optionRows = await findProductOptionsByBarcode(code);
  if (optionRows.length) return { matchType: "product_option_barcode", rows: optionRows };

  return { matchType: "none", rows: [] };
}

async function searchProductsByName(query) {
  const directMatches = await searchProductsDirect(query);
  if (directMatches.length) return dedupeSearchResults(directMatches);

  const productMatches = await searchProducts(query);
  return dedupeSearchResults(productMatches);
}

async function searchProductsDirect(query) {
  const directRows = [];

  const lookup = await findStockRows(query);
  if (lookup.rows.length) {
    const rows = await Promise.all(lookup.rows.slice(0, 20).map(stockRowToSearchResult));
    directRows.push(...rows);
  }

  const optionRows = await findProductOptionsBySku(query);
  if (optionRows.length) {
    directRows.push(...await Promise.all(optionRows.slice(0, 20).map(productOptionToSearchResult)));
  }

  return directRows;
}

async function searchProducts(query) {
  const products = await getCachedProducts();
  const words = searchWords(query);
  return products
    .filter((product) => matchesWords(searchTextForProduct(product), words))
    .flatMap((product) => {
      const productName = product.name ?? product.Name ?? product.productName ?? product.ProductName ?? "";
      const productId = product.id ?? product.Id ?? product.ID;
      const options = asArray(product.productOptions ?? product.ProductOptions ?? product.options ?? product.Options);
      if (!options.length) return [searchResultFromOption({ productName, productId }, product)];

      return options.map((option) => searchResultFromOption({ ...option, productName, productId }, product));
    });
}

function searchResultFromOption(option, product = null) {
  const priceTiers = extractPriceTiers(option, option);
  const name = buildProductName(option, option);
  return {
    barcode: barcodeValue(option),
    sku: option.code ?? option.Code ?? option.productOptionCode ?? option.ProductOptionCode ?? "",
    price: priceTiers.special || priceTiers.retail || "",
    priceSource: priceTiers.special ? "special" : "retail",
    priceTiers,
    imageUrl: imageUrlFrom(option, product),
    productTitle: name,
    variantTitle: "",
    productId: option.productId ?? option.ProductId ?? product?.id ?? product?.Id ?? product?.ID ?? "",
    productOptionId: option.productOptionId ?? option.ProductOptionId ?? option.id ?? option.Id ?? option.ID ?? "",
    cin7Quantity: "",
    matchType: "name_search"
  };
}

async function stockRowToSearchResult(stock) {
  const productOptionId = stock.productOptionId ?? stock.ProductOptionId;
  const productId = stock.productId ?? stock.ProductId;
  const option = await getBestProductOption(productId, productOptionId, barcodeValue(stock));
  const product = productId ? await getProduct(productId) : null;
  const priceTiers = mergePriceTiers(extractPriceTiers(option, option), extractPriceTiers(stock, stock));

  return {
    barcode: barcodeValue(stock) || barcodeValue(option),
    sku: stock.code ?? stock.Code ?? option?.code ?? option?.Code ?? "",
    price: priceTiers.special || priceTiers.retail || "",
    priceSource: priceTiers.special ? "special" : "retail",
    priceTiers,
    imageUrl: imageUrlFrom(option, product, stock),
    productTitle: buildProductName(stock, option),
    variantTitle: "",
    productId: productId ?? option?.productId ?? option?.ProductId ?? "",
    productOptionId: productOptionId ?? option?.id ?? option?.Id ?? option?.ID ?? "",
    cin7Quantity: stock.stockOnHand ?? stock.StockOnHand ?? stock.available ?? stock.Available ?? "",
    matchType: "direct_search"
  };
}

async function productOptionToSearchResult(option) {
  const productId = option.productId ?? option.ProductId;
  const product = productId ? await getProduct(productId) : null;
  const productName = product?.name ?? product?.Name ?? product?.productName ?? product?.ProductName ?? option.productName ?? option.ProductName ?? "";
  return searchResultFromOption({
    ...option,
    productName,
    productId
  }, product);
}

function dedupeSearchResults(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.productId}|${row.productOptionId}|${row.sku}|${row.productTitle}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function getCachedProducts() {
  const now = Date.now();
  if (productSearchCache.expiresAt > now) return productSearchCache.rows;

  const rows = await warmProductCache();
  return rows;
}

async function warmProductCache() {
  const now = Date.now();
  if (productSearchCache.expiresAt > now && productSearchCache.rows.length) return productSearchCache.rows;
  if (productSearchWarmup) return productSearchWarmup;

  productSearchWarmup = fetchProductPages(searchPageLimit, searchRowsPerPage, true)
    .then((rows) => {
      productSearchCache = { expiresAt: Date.now() + searchCacheMs, rows };
      return rows;
    })
    .finally(() => {
      productSearchWarmup = null;
    });

  return productSearchWarmup;
}

function cacheStatus() {
  const now = Date.now();
  return {
    warm: productSearchCache.expiresAt > now && productSearchCache.rows.length > 0,
    warming: Boolean(productSearchWarmup),
    count: productSearchCache.rows.length,
    expiresAt: productSearchCache.expiresAt ? new Date(productSearchCache.expiresAt).toISOString() : "",
    expiresInSeconds: productSearchCache.expiresAt > now ? Math.round((productSearchCache.expiresAt - now) / 1000) : 0
  };
}

async function fetchProductPages(pageCount, rows, stopWhenShort = true) {
  const pages = [];
  for (let page = 1; page <= pageCount; page += 1) {
    const batch = asArray(await cin7Get("/Products", { page: String(page), rows: String(rows) }));
    if (!batch.length) break;
    pages.push(...batch);
    if (stopWhenShort && batch.length < rows) break;
    if (page < pageCount) await sleep(searchRequestDelayMs);
  }
  return pages;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function searchWords(value) {
  return normaliseSearchText(value).split(/\s+/).filter(Boolean);
}

function matchesWords(text, words) {
  const haystack = normaliseSearchText(text);
  return words.every((word) => haystack.includes(word));
}

function normaliseSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/(\d)[./-](\d)/g, "$1$2")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function searchTextForProduct(product) {
  const options = asArray(product.productOptions ?? product.ProductOptions ?? product.options ?? product.Options);
  return [
    product.name,
    product.Name,
    product.productName,
    product.ProductName,
    product.code,
    product.Code,
    product.sku,
    product.SKU,
    ...options.map(searchTextForProductOption)
  ].filter(Boolean).join(" ");
}

function searchTextForProductOption(option) {
  return [
    option.productName,
    option.ProductName,
    option.name,
    option.Name,
    option.option1,
    option.Option1,
    option.option2,
    option.Option2,
    option.option3,
    option.Option3,
    option.size,
    option.Size,
    option.code,
    option.Code,
    option.productOptionCode,
    option.ProductOptionCode,
    barcodeValue(option)
  ].filter(Boolean).join(" ");
}

function chooseStockRow(rows, code, branchId) {
  if (!rows.length) return null;
  const branchRows = branchId ? rows.filter((row) => String(row.branchId ?? row.BranchId) === branchId) : rows;
  const candidates = branchRows.length ? branchRows : rows;
  return candidates.find((row) => sameCode(barcodeValue(row), code)) ||
    (candidates.length === 1 ? candidates[0] : null);
}

async function getProductOption(productOptionId) {
  try {
    const result = await cin7Get(`/ProductOptions/${encodeURIComponent(productOptionId)}`);
    return Array.isArray(result) ? result[0] : result;
  } catch {
    return null;
  }
}

async function getBestProductOption(productId, productOptionId, barcode = "") {
  const directOption = productOptionId ? await getProductOption(productOptionId) : null;
  if (hasPriceData(directOption)) return directOption;

  const product = productId ? await getProduct(productId) : null;
  const productOptions = asArray(product?.productOptions ?? product?.ProductOptions ?? product?.options ?? product?.Options);
  const matchedOption = productOptions.find((option) => sameProductOption(option, productOptionId, barcode)) ||
    productOptions.find((option) => sameCode(barcodeValue(option), barcode)) ||
    productOptions.find((option) => String(option.id ?? option.Id ?? option.ID) === String(productOptionId)) ||
    null;

  if (matchedOption && directOption) return { ...directOption, ...matchedOption };
  return matchedOption || directOption;
}

async function findProductOptionsByBarcode(code) {
  const fields = [
    "barcode",
    "Barcode",
    "productOptionBarcode",
    "ProductOptionBarcode",
    "productOptionSizeBarcode",
    "ProductOptionSizeBarcode"
  ];

  for (const field of fields) {
    try {
      const rows = asArray(await cin7Get("/ProductOptions", {
        where: `${field}='${escapeWhereValue(code)}'`,
        rows: "20"
      }));
      const exact = rows.filter((row) => sameCode(barcodeValue(row), code));
      if (exact.length) return Promise.all(exact.map(productOptionToStockRow));
    } catch {
      // Cin7 accounts can expose different ProductOptions field names.
    }
  }

  return [];
}

async function findProductOptionsBySku(sku) {
  const fields = [
    "code",
    "Code",
    "productOptionCode",
    "ProductOptionCode"
  ];

  for (const field of fields) {
    try {
      const rows = asArray(await cin7Get("/ProductOptions", {
        where: `${field}='${escapeWhereValue(sku)}'`,
        rows: "20"
      }));
      const exact = rows.filter((row) => sameCode(row.code ?? row.Code ?? row.productOptionCode ?? row.ProductOptionCode, sku));
      if (exact.length) return exact;
    } catch {
      // Cin7 accounts can expose different ProductOptions field names.
    }
  }

  return [];
}

async function productOptionToStockRow(option) {
  const productId = option.productId ?? option.ProductId;
  const product = productId ? await getProduct(productId) : null;
  return {
    ...option,
    productId,
    productOptionId: option.id ?? option.Id ?? option.ID,
    productName: product?.name ?? product?.Name ?? product?.productName ?? product?.ProductName ?? "",
    barcode: barcodeValue(option),
    code: option.code ?? option.Code ?? option.productOptionCode ?? option.ProductOptionCode ?? "",
    stockOnHand: ""
  };
}

async function getProduct(productId) {
  try {
    const result = await cin7Get(`/Products/${encodeURIComponent(productId)}`);
    return Array.isArray(result) ? result[0] : result;
  } catch {
    return null;
  }
}

async function cin7Get(path, params = {}) {
  if (!cin7Username || !cin7ApiKey) throw new Error("Cin7 backend is missing CIN7_API_USERNAME or CIN7_API_KEY");

  const url = new URL(`${cin7BaseUrl}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== "" && value !== null && value !== undefined) url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "Authorization": `Basic ${Buffer.from(`${cin7Username}:${cin7ApiKey}`).toString("base64")}`
    }
  });

  const json = await readJsonResponse(response, "Cin7 Omni API");
  if (!response.ok) {
    const message = json?.message || json?.Message || `Cin7 Omni API returned ${response.status}`;
    throw new Error(message);
  }
  return json;
}

async function cin7Send(method, path, body) {
  if (!cin7Username || !cin7ApiKey) throw new Error("Cin7 backend is missing CIN7_API_USERNAME or CIN7_API_KEY");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), cin7WriteTimeoutMs);
  let response;
  try {
    response = await fetch(`${cin7BaseUrl}${path}`, {
      method,
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": `Basic ${Buffer.from(`${cin7Username}:${cin7ApiKey}`).toString("base64")}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Cin7 did not respond within ${Math.round(cin7WriteTimeoutMs / 1000)} seconds. Try fewer stocktake lines first.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const json = await readJsonResponse(response, "Cin7 Omni API");
  if (!response.ok) {
    const message = json?.message || json?.Message || json?.errors?.join(", ") || `Cin7 Omni API returned ${response.status}`;
    throw new Error(message);
  }
  return json;
}

async function runStockUpdateJob(jobId, adjustment) {
  const job = updateJobs.get(jobId);
  if (!job) return;
  job.status = "running";
  try {
    const result = await cin7Send("POST", "/Adjustments", [adjustment]);
    job.status = adjustmentSucceeded(result) ? "complete" : "failed";
    job.result = result;
    job.error = job.status === "failed" ? batchErrors(result).join("; ") || "Cin7 rejected the stock adjustment" : "";
  } catch (error) {
    job.status = "failed";
    job.error = error.message || "Cin7 stock update failed";
  } finally {
    job.completedAt = new Date().toISOString();
    updateJobs.set(jobId, job);
    setTimeout(() => updateJobs.delete(jobId), 60 * 60 * 1000);
  }
}

function adjustmentSucceeded(result) {
  const rows = asArray(result);
  return rows.length > 0 && rows.every((row) => row.success === true || row.Success === true);
}

function batchErrors(result) {
  return asArray(result).flatMap((row) => asArray(row.errors ?? row.Errors)).filter(Boolean);
}

async function stocktakeItemToAdjustmentLine(item, index, branchId = "") {
  const repaired = await repairStocktakeItem(item, branchId);
  const counted = numericValue(item.countedQty ?? item.qty);
  const current = numericValue(repaired.currentQty ?? repaired.expectedCount);
  const productOptionId = numericValue(repaired.productOptionId);
  const qty = counted - current;

  if (!Number.isFinite(counted) || !Number.isFinite(current) || !Number.isFinite(productOptionId) || productOptionId <= 0) {
    return {
      ok: false,
      reason: {
        code: item.code || "",
        sku: item.sku || "",
        name: item.name || "",
        productOptionId: repaired.productOptionId ?? item.productOptionId ?? "",
        currentQty: repaired.currentQty ?? repaired.expectedCount ?? item.currentQty ?? item.expectedCount ?? "",
        countedQty: item.countedQty ?? item.qty ?? "",
        issue: "Missing product option, current stock, or counted stock"
      }
    };
  }

  return {
    ok: true,
    line: {
      productOptionId,
      code: String(item.sku || item.code || ""),
      name: String(item.name || ""),
      sort: index + 1,
      qty,
      qtyAdjusted: qty
    }
  };
}

async function repairStocktakeItem(item, branchId = "") {
  const current = numericValue(item.currentQty ?? item.expectedCount);
  const productOptionId = numericValue(item.productOptionId);
  if (Number.isFinite(current) && Number.isFinite(productOptionId) && productOptionId > 0) {
    return item;
  }

  const lookupCode = String(item.code || item.barcode || item.sku || "").trim();
  if (!lookupCode) return item;

  try {
    const lookup = await findStockRows(lookupCode);
    const stock = chooseStockRow(lookup.rows, lookupCode, String(branchId || ""));
    if (!stock) return item;

    const repairedProductOptionId = stock.productOptionId ?? stock.ProductOptionId ?? item.productOptionId;
    const stockOnHand = stock.stockOnHand ?? stock.StockOnHand ?? stock.available ?? stock.Available ?? item.currentQty ?? item.expectedCount;
    return {
      ...item,
      productOptionId: repairedProductOptionId,
      currentQty: stockOnHand,
      expectedCount: stockOnHand,
      sku: item.sku || stock.code || stock.Code || "",
      name: item.name || stock.productName || stock.ProductName || ""
    };
  } catch {
    return item;
  }
}

function numericValue(value) {
  if (value === "" || value === null || value === undefined) return NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function stocktakeReference() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(2, 14);
  return `STK-${stamp}`.slice(0, 20);
}

async function readJsonResponse(response, source) {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    const preview = text.replace(/\s+/g, " ").slice(0, 140);
    throw new Error(`${source} returned non-JSON. Check the API username/key and permissions. Response: ${preview}`);
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : value ? [value] : [];
}

function stockSummary(row) {
  const priceTiers = extractPriceTiers(row, row);
  return {
    productName: row.productName ?? row.ProductName ?? "",
    barcode: barcodeValue(row),
    sku: row.code ?? row.Code ?? "",
    priceTiers,
    priceKeys: Object.keys(row).filter((key) => /price|freelance|freelancer|vip|wholesale|special/i.test(key)),
    priceColumns: row.priceColumns ?? row.PriceColumns ?? row.prices ?? row.Prices ?? "",
    branchId: row.branchId ?? row.BranchId ?? "",
    branchName: row.branchName ?? row.BranchName ?? "",
    productId: row.productId ?? row.ProductId ?? "",
    productOptionId: row.productOptionId ?? row.ProductOptionId ?? "",
    stockOnHand: row.stockOnHand ?? row.StockOnHand ?? row.available ?? row.Available ?? ""
  };
}

async function debugStockSummary(row) {
  const productOptionId = row.productOptionId ?? row.ProductOptionId;
  const productId = row.productId ?? row.ProductId;
  const option = await getBestProductOption(productId, productOptionId, barcodeValue(row));
  const product = productId ? await getProduct(productId) : null;
  const stockPrices = extractPriceTiers(row, row);
  const optionPrices = extractPriceTiers(option, option);

  return {
    ...stockSummary(row),
    imageUrl: imageUrlFrom(option, product, row),
    stockImageKeys: imageKeys(row),
    optionImageKeys: imageKeys(option),
    productImageKeys: imageKeys(product),
    optionPriceTiers: optionPrices,
    finalPriceTiers: mergePriceTiers(optionPrices, stockPrices),
    optionPriceKeys: option ? Object.keys(option).filter((key) => /price|freelance|freelancer|vip|wholesale|special/i.test(key)) : [],
    optionPriceColumns: option?.priceColumns ?? option?.PriceColumns ?? option?.prices ?? option?.Prices ?? "",
    optionFound: Boolean(option)
  };
}

function sameProductOption(option, productOptionId, barcode) {
  if (!option) return false;
  const ids = [
    option.productOptionId,
    option.ProductOptionId,
    option.id,
    option.Id,
    option.ID,
    option.code,
    option.Code,
    option.productOptionCode,
    option.ProductOptionCode
  ].map((value) => String(value ?? ""));

  return ids.includes(String(productOptionId ?? "")) || sameCode(barcodeValue(option), barcode);
}

function hasPriceData(value) {
  if (!value) return false;
  return Object.keys(value).some((key) => /price|freelance|freelancer|vip|wholesale|special/i.test(key)) ||
    Boolean(value.priceColumns ?? value.PriceColumns ?? value.prices ?? value.Prices);
}

function mergePriceTiers(primary = {}, fallback = {}) {
  return {
    retail: primary.retail || fallback.retail || "",
    freelance: primary.freelance || fallback.freelance || "",
    vipRetail: primary.vipRetail || fallback.vipRetail || "",
    wholesale: primary.wholesale || fallback.wholesale || "",
    special: primary.special || fallback.special || ""
  };
}

function barcodeValue(row) {
  return row?.barcode ?? row?.Barcode ?? row?.productOptionBarcode ?? row?.ProductOptionBarcode ?? row?.productOptionSizeBarcode ?? row?.ProductOptionSizeBarcode ?? "";
}

function sameCode(left, right) {
  return normaliseLookupCode(left) === normaliseLookupCode(right);
}

function normaliseLookupCode(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function buildProductName(stock, option) {
  const base = stock.productName ?? stock.ProductName ?? "";
  const parts = [
    option?.option1 ?? option?.Option1 ?? stock.option1 ?? stock.Option1,
    option?.option2 ?? option?.Option2 ?? stock.option2 ?? stock.Option2,
    option?.option3 ?? option?.Option3 ?? stock.option3 ?? stock.Option3,
    option?.size ?? option?.Size ?? stock.size ?? stock.Size
  ].filter(Boolean);
  return [base, parts.join(" / ")].filter(Boolean).join(" - ") || "Unnamed item";
}

function imageUrlFrom(...sources) {
  const directFields = [
    "imageUrl", "ImageUrl", "imageURL", "ImageURL",
    "imageLink", "ImageLink", "imageHref", "ImageHref",
    "image", "Image", "photo", "Photo",
    "photoUrl", "PhotoUrl", "photoURL", "PhotoURL",
    "photoLink", "PhotoLink",
    "thumbnail", "Thumbnail", "thumbnailUrl", "ThumbnailUrl",
    "thumbnailURL", "ThumbnailURL", "picture", "Picture",
    "pictureUrl", "PictureUrl", "src", "Src", "source", "Source",
    "href", "Href", "link", "Link", "downloadUrl", "DownloadUrl",
    "fileUrl", "FileUrl", "fileURL", "FileURL", "assetUrl", "AssetUrl",
    "publicUrl", "PublicUrl", "secureUrl", "SecureUrl", "url", "URL"
  ];
  const arrayFields = [
    "images", "Images", "productImages", "ProductImages",
    "photos", "Photos", "attachments", "Attachments",
    "files", "Files", "media", "Media", "assets", "Assets"
  ];

  const seen = new Set();
  const find = (value, depth = 0) => {
    if (!value || depth > 4) return "";
    if (typeof value === "string") return normaliseImageUrl(value);
    if (typeof value !== "object" || seen.has(value)) return "";
    seen.add(value);

    for (const field of directFields) {
      const found = find(value[field], depth + 1);
      if (found) return found;
    }

    for (const field of arrayFields) {
      const rows = asArray(value[field]).slice(0, 8);
      for (const row of rows) {
        const found = find(row, depth + 1);
        if (found) return found;
      }
    }

    return "";
  };

  for (const source of sources) {
    const found = find(source);
    if (found) return found;
  }
  return "";
}

function imageKeys(source) {
  if (!source || typeof source !== "object") return [];
  return Object.keys(source).filter((key) => /image|photo|picture|thumbnail|asset|attachment|media|file|url|link/i.test(key));
}

function normaliseImageUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.startsWith("//")) return `https:${text}`;
  if (/^https?:\/\//i.test(text)) return text;
  if (/^data:image\//i.test(text)) return text;
  try {
    return new URL(text.replace(/^\/+/, ""), `${cin7BaseUrl}/`).href;
  } catch {
    return "";
  }
}

function extractPriceTiers(option, stock) {
  const source = { ...(stock || {}), ...(option || {}) };
  const priceColumns = priceColumnEntries(source.priceColumns ?? source.PriceColumns ?? source.prices ?? source.Prices);
  const priceColumnObject = source.priceColumns ?? source.PriceColumns ?? source.prices ?? source.Prices ?? {};

  return {
    retail: pickPrice(source, priceColumns, ["retailPrice", "RetailPrice", "retailAUD", "RetailAUD", "retail", "Retail"]),
    freelance: pickPrice(source, priceColumns, ["freelancePrice", "FreelancePrice", "freelancerPrice", "FreelancerPrice", "freelance", "Freelance", "freelancer", "Freelancer", "freelancerAUD", "FreelancerAUD", "freelancer aud", "Freelancer AUD", "freelancer price", "Freelancer Price"]) || priceColumnObject.freelancerAUD || priceColumnObject.FreelancerAUD || "",
    vipRetail: pickPrice(source, priceColumns, ["vipPrice", "VIPPrice", "vipRetailAUD", "VipRetailAUD", "VIPRetailAUD", "vipRetailPrice", "VIPRetailPrice", "vipRetail", "VipRetail", "vip retail", "VIP Retail", "vip"]),
    wholesale: pickPrice(source, priceColumns, ["wholesalePrice", "WholesalePrice", "wholesaleAUD", "WholesaleAUD", "wholesale", "Wholesale"]),
    special: pickPrice(source, priceColumns, ["specialPrice", "SpecialPrice", "spRetailAUD", "SpRetailAUD", "SPRetailAUD", "special", "Special"])
  };
}

function priceColumnEntries(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(normalisePriceColumn);
  if (typeof value === "object") {
    return Object.entries(value).map(([name, price]) => normalisePriceColumn({ name, price }));
  }
  return [];
}

function normalisePriceColumn(column) {
  const price = column.price ?? column.Price ?? column.value ?? column.Value ?? column.amount ?? column.Amount ?? column.sellPrice ?? column.SellPrice;
  if (price && typeof price === "object") {
    return {
      ...column,
      price: price.price ?? price.Price ?? price.value ?? price.Value ?? price.amount ?? price.Amount ?? price.sellPrice ?? price.SellPrice ?? ""
    };
  }
  return column;
}

function pickPrice(source, priceColumns, names) {
  for (const name of names) {
    const direct = source[name];
    if (direct !== "" && direct !== null && direct !== undefined) return direct;
  }

  const normalisedNames = names.map(normalisePriceName);
  for (const column of priceColumns) {
    const label = normalisePriceName(column.name ?? column.Name ?? column.priceName ?? column.PriceName ?? column.label ?? column.Label);
    if (!normalisedNames.includes(label)) continue;
    const value = column.price ?? column.Price ?? column.value ?? column.Value ?? column.amount ?? column.Amount ?? column.sellPrice ?? column.SellPrice;
    if (value !== "" && value !== null && value !== undefined) return value;
  }

  return "";
}

function normalisePriceName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function escapeWhereValue(value) {
  return String(value).replace(/'/g, "''");
}

function sendError(res, error) {
  res.status(500).json({ error: error.message || "Cin7 Omni connector error" });
}

app.listen(port, () => {
  console.log(`Scanner Cin7 Omni connector running on port ${port}`);
});
