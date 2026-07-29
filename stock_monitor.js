const fs = require("fs");
const path = require("path");
const YahooFinance = require("yahoo-finance2").default;
const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const CONFIG_PATH = path.join(__dirname, "stocks.json");
const STATE_PATH = path.join(__dirname, "alert_state.json");

const SENDKEY = process.env.SERVERCHAN_SENDKEY || "";

// ------------------- 配置加载 -------------------

function loadStocks() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  return raw.map(s => ({
    code: s.code,
    referencePrice: s.referencePrice,
    threshold: s.threshold || 0.4,
  }));
}

// ------------------- A股代码自动补后缀 -------------------

function toYahooSymbol(code) {
  if (code.includes(".")) return code;
  if (/^\d{6}$/.test(code)) {
    return code[0] === "6" ? code + ".SS" : code + ".SZ";
  }
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
    console.log(data.code === 0
      ? `  ✅ 微信推送成功: ${stock.code}`
      : `  ❌ 推送失败: ${JSON.stringify(data)}`);
  } catch (err) {
    console.log(`  ❌ 推送异常: ${err.message}`);
  }
}

// ------------------- 状态文件 -------------------

function loadState() {
  try {
    if (fs.existsSync(STATE_PATH)) return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
  } catch (_) {}
  return {};
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ------------------- 主逻辑 -------------------

async function main() {
  console.log(`[${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}] 开始检查...`);

  const stocks = loadStocks();
  if (stocks.length === 0) {
    console.log("stocks.json 中没有股票数据。");
    return;
  }

  const state = loadState();
  const yahooSymbols = stocks.map(s => toYahooSymbol(s.code));
  const codeMap = {};
  stocks.forEach((s, i) => { codeMap[yahooSymbols[i]] = s; });

  console.log(`拉取 ${yahooSymbols.length} 只股票行情...`);

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
      const prev = state[stock.code];
      if (!prev || prev.dropPct < stock.threshold) {
        await sendAlert(stock, price, dropPct);
        state[stock.code] = { dropPct, price, time: now };
        hadAlert = true;
      } else {
        console.log(`  ⏭️ ${stock.code}: 已告警过（${(prev.dropPct * 100).toFixed(1)}%），跳过`);
      }
    } else {
      if (state[stock.code]) {
        delete state[stock.code];
        console.log(`  ↻ ${stock.code}: 回升至阈值以上，重置告警状态`);
      }
    }
  }

  saveState(state);
  if (hadAlert) console.log("\n⚠️  alert_state.json 已更新。");
  console.log("\n检查完成。");
}

main().catch(err => { console.error(err); process.exit(1); });
