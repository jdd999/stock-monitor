const fs = require("fs");
const path = require("path");
const YahooFinance = require("yahoo-finance2").default;
const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const CSV_PATH = path.join(__dirname, "stocks.csv");
const STATE_PATH = path.join(__dirname, "alert_state.json");

// Server酱 sendkey，部署时通过 GitHub Actions secret 注入
const SENDKEY = process.env.SERVERCHAN_SENDKEY || "";

// ------------------- CSV 解析 -------------------

function parseCSV(text) {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];
  const stocks = [];
  for (let i = 1; i < lines.length; i++) {
    const [code, refPrice, threshold] = lines[i].split(",").map(s => s.trim());
    if (!code || !refPrice) continue;
    stocks.push({
      code,
      referencePrice: parseFloat(refPrice),
      threshold: threshold ? parseFloat(threshold) : 0.4,
    });
  }
  return stocks;
}

// ------------------- A股代码自动补后缀 -------------------

function toYahooSymbol(code) {
  // 已经是 yahoo 格式（含 . 的）直接返回
  if (code.includes(".")) return code;
  // 6 位纯数字 → A股
  if (/^\d{6}$/.test(code)) {
    const first = code[0];
    if (first === "6") return code + ".SS";   // 上海
    return code + ".SZ";                       // 深圳（0/3 开头）
  }
  // 其他代码原样返回（港股 4 位数字、美股字母等）
  return code;
}

// ------------------- Server酱 推送 -------------------

async function sendAlert(stock, currentPrice, dropPct) {
  if (!SENDKEY) {
    console.log(`  [DRY RUN] 跳过推送：${stock.code} 跌幅 ${dropPct.toFixed(1)}%`);
    return;
  }
  const title = `📉 ${stock.code} 跌幅告警`;
  const desp = [
    `**股票代码**: ${stock.code}`,
    `**当前价格**: ¥${currentPrice.toFixed(2)}`,
    `**关注价格**: ¥${stock.referencePrice.toFixed(2)}`,
    `**跌幅**: ${(dropPct * 100).toFixed(1)}%`,
    `**时间**: ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
  ].join("\n\n");

  try {
    const resp = await fetch(`https://sctapi.ftqq.com/${SENDKEY}.send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, desp }),
    });
    const data = await resp.json();
    if (data.code === 0) {
      console.log(`  ✅ 微信推送成功: ${stock.code}`);
    } else {
      console.log(`  ❌ 推送失败: ${JSON.stringify(data)}`);
    }
  } catch (err) {
    console.log(`  ❌ 推送异常: ${err.message}`);
  }
}

// ------------------- 状态文件（防重复告警）-------------------

function loadState() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
    }
  } catch (_) {}
  return {};
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ------------------- 主逻辑 -------------------

async function main() {
  console.log(`[${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}] 开始检查...`);

  const csvText = fs.readFileSync(CSV_PATH, "utf-8");
  const stocks = parseCSV(csvText);

  if (stocks.length === 0) {
    console.log("stocks.csv 中没有股票数据。");
    return;
  }

  const state = loadState();

  // 构建 yahoo 符号映射
  const yahooSymbols = stocks.map(s => toYahooSymbol(s.code));
  const codeMap = {};
  stocks.forEach((s, i) => { codeMap[yahooSymbols[i]] = s; });

  console.log(`拉取 ${yahooSymbols.length} 只股票行情...`);

  // yahoo-finance2 批量查询
  let quotes;
  try {
    quotes = await yahooFinance.quote(yahooSymbols);
  } catch (err) {
    console.error(`行情拉取失败: ${err.message}`);
    return;
  }
  const quotesArr = Array.isArray(quotes) ? quotes : [quotes];

  const now = new Date().toISOString();
  let hadAlert = false;

  for (const q of quotesArr) {
    const sym = q.symbol;
    const stock = codeMap[sym];
    if (!stock) continue;

    const price = q.regularMarketPrice;
    if (!price) {
      console.log(`  ⚠️ ${stock.code}: 无行情数据`);
      continue;
    }

    const ref = stock.referencePrice;
    const dropPct = (ref - price) / ref;

    const emoji = dropPct >= stock.threshold ? "🔴" : "🟢";
    console.log(`  ${emoji} ${stock.code}: ¥${price.toFixed(2)} | 关注价 ¥${ref.toFixed(2)} | 跌幅 ${(dropPct * 100).toFixed(1)}%`);

    if (dropPct >= stock.threshold) {
      // 检查是否已告警过（避免重复骚扰）
      const prev = state[stock.code];
      if (!prev || prev.dropPct < stock.threshold) {
        await sendAlert(stock, price, dropPct);
        state[stock.code] = { dropPct, price, time: now };
        hadAlert = true;
      } else {
        console.log(`  ⏭️ ${stock.code}: 已告警过（${(prev.dropPct * 100).toFixed(1)}%），跳过`);
      }
    } else {
      // 价格回升到阈值以上 → 重置告警状态，下次再跌会重新告警
      if (state[stock.code]) {
        delete state[stock.code];
        console.log(`  ↻ ${stock.code}: 回升至阈值以上，重置告警状态`);
      }
    }
  }

  saveState(state);

  if (hadAlert) {
    // 标记状态文件有变更，GitHub Actions 会提交它
    console.log("\n⚠️  alert_state.json 已更新，需要 commit 以保持状态。");
  }

  console.log("\n检查完成。");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
