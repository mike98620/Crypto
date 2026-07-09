/**
 * 加密貨幣策略訊號監控 → LINE 推播
 * ------------------------------------------------------------
 * 這支程式會：
 *   1. 抓取指定幣種的歷史價格（CoinGecko 或 Binance）
 *   2. 用你選的策略（均線交叉 / RSI / MACD / 布林通道）計算訊號
 *   3. 如果最新一根 K 棒出現「新的」買進或賣出訊號，就用 LINE Messaging API
 *      推播訊息給你（避免同一個訊號重複通知，靠 state/last_alert.json 記錄）
 *
 * 需要的環境變數（在 GitHub Actions 的 Secrets 裡設定）：
 *   LINE_CHANNEL_ACCESS_TOKEN  你的 LINE Messaging API Channel Access Token
 *   LINE_USER_ID               你自己的 LINE User ID
 *
 * 可調整的參數（直接改下面 CONFIG 這一段就好，不需要動到程式邏輯）：
 * ------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

// ========================= 設定區（自己改這裡） =========================
// TARGETS 是一個陣列，可以放任意多筆，每一筆各自獨立設定幣種/資料來源/週期/策略
const TARGETS = [
  { label: 'BTC', source: 'coingecko', coinGeckoId: 'bitcoin', days: 180, strategy: 'sma' },
  { label: 'ETH', source: 'coingecko', coinGeckoId: 'ethereum', days: 180, strategy: 'sma' },
  { label: 'SOL', source: 'coingecko', coinGeckoId: 'solana', days: 180, strategy: 'sma' },
  { label: 'BNB', source: 'coingecko', coinGeckoId: 'binancecoin', days: 180, strategy: 'sma' },
  // 想再加其他幣種，複製上面一行改一下就好，可用的 coinGeckoId 例如：
  // ripple(XRP) / dogecoin(DOGE) / cardano(ADA)
];
// ======================================================================


const STATE_FILE = path.join(__dirname, 'state', 'last_alert.json');

function loadState(){
  try{
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  }catch(e){
    return {}; // { [label]: lastAlertKey }
  }
}
function saveState(state){
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------- 指標計算（跟網頁工具邏輯一致） ----------
function sma(arr, period){
  const out = new Array(arr.length).fill(null);
  let sum = 0;
  for(let i=0;i<arr.length;i++){
    sum += arr[i];
    if(i>=period) sum -= arr[i-period];
    if(i>=period-1) out[i] = sum/period;
  }
  return out;
}
function ema(arr, period){
  const out = new Array(arr.length).fill(null);
  const k = 2/(period+1);
  let prev = null;
  for(let i=0;i<arr.length;i++){
    if(arr[i]==null) continue;
    if(prev===null){
      if(i>=period-1){
        const slice = arr.slice(i-period+1, i+1);
        prev = slice.reduce((a,b)=>a+b,0)/period;
        out[i]=prev;
      }
    } else {
      prev = arr[i]*k + prev*(1-k);
      out[i]=prev;
    }
  }
  return out;
}
function rsi(arr, period=14){
  const out = new Array(arr.length).fill(null);
  let gains=0, losses=0;
  for(let i=1;i<arr.length;i++){
    const diff = arr[i]-arr[i-1];
    const g = diff>0?diff:0, l = diff<0?-diff:0;
    if(i<=period){
      gains+=g; losses+=l;
      if(i===period){
        const avgG=gains/period, avgL=losses/period;
        out[i] = avgL===0?100:100-(100/(1+avgG/avgL));
        gains=avgG; losses=avgL;
      }
    } else {
      gains = (gains*(period-1)+g)/period;
      losses = (losses*(period-1)+l)/period;
      out[i] = losses===0?100:100-(100/(1+gains/losses));
    }
  }
  return out;
}
function macdCalc(arr, fast=12, slow=26, signal=9){
  const emaFast = ema(arr, fast);
  const emaSlow = ema(arr, slow);
  const macdLine = arr.map((_,i)=> (emaFast[i]!=null && emaSlow[i]!=null) ? emaFast[i]-emaSlow[i] : null);
  const cleaned = macdLine.map(v=>v==null?0:v);
  const signalLineRaw = ema(cleaned, signal);
  const signalLine = macdLine.map((v,i)=> v==null?null:signalLineRaw[i]);
  return { macdLine, signalLine };
}
function bollinger(arr, period=20, mult=2){
  const mid = sma(arr, period);
  const upper = new Array(arr.length).fill(null);
  const lower = new Array(arr.length).fill(null);
  for(let i=0;i<arr.length;i++){
    if(mid[i]==null) continue;
    const slice = arr.slice(i-period+1, i+1);
    const mean = mid[i];
    const variance = slice.reduce((a,b)=>a+Math.pow(b-mean,2),0)/period;
    const sd = Math.sqrt(variance);
    upper[i]=mean+mult*sd; lower[i]=mean-mult*sd;
  }
  return { upper, lower };
}

function generateSignals(prices, strategy){
  const buySignal = new Array(prices.length).fill(false);
  const sellSignal = new Array(prices.length).fill(false);

  if(strategy==='sma'){
    const f = sma(prices,20), s = sma(prices,50);
    for(let i=1;i<prices.length;i++){
      if(f[i-1]==null||s[i-1]==null||f[i]==null||s[i]==null) continue;
      if(f[i-1]<=s[i-1] && f[i]>s[i]) buySignal[i]=true;
      if(f[i-1]>=s[i-1] && f[i]<s[i]) sellSignal[i]=true;
    }
  } else if(strategy==='rsi'){
    const r = rsi(prices,14);
    for(let i=1;i<prices.length;i++){
      if(r[i-1]==null||r[i]==null) continue;
      if(r[i-1]<30 && r[i]>=30) buySignal[i]=true;
      if(r[i-1]>70 && r[i]<=70) sellSignal[i]=true;
    }
  } else if(strategy==='macd'){
    const { macdLine, signalLine } = macdCalc(prices);
    for(let i=1;i<prices.length;i++){
      if(macdLine[i-1]==null||signalLine[i-1]==null||macdLine[i]==null||signalLine[i]==null) continue;
      if(macdLine[i-1]<=signalLine[i-1] && macdLine[i]>signalLine[i]) buySignal[i]=true;
      if(macdLine[i-1]>=signalLine[i-1] && macdLine[i]<signalLine[i]) sellSignal[i]=true;
    }
  } else if(strategy==='boll'){
    const { upper, lower } = bollinger(prices,20,2);
    for(let i=1;i<prices.length;i++){
      if(lower[i-1]==null||upper[i-1]==null) continue;
      if(prices[i-1]<lower[i-1] && prices[i]>=lower[i]) buySignal[i]=true;
      if(prices[i-1]>upper[i-1] && prices[i]<=upper[i]) sellSignal[i]=true;
    }
  }
  return { buySignal, sellSignal };
}

// ---------- 資料抓取 ----------
async function fetchCoinGecko(id, days){
  const url = `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=${days}`;
  const res = await fetch(url);
  if(!res.ok) throw new Error('CoinGecko API 錯誤 ' + res.status);
  const json = await res.json();
  const dates = json.prices.map(p => new Date(p[0]).toISOString().slice(0,10));
  const prices = json.prices.map(p => p[1]);
  return { dates, prices };
}
async function fetchBinance(symbol, interval, limit){
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if(!res.ok) throw new Error('Binance API 錯誤 ' + res.status);
  const json = await res.json();
  const dates = json.map(k => new Date(k[0]).toISOString());
  const prices = json.map(k => parseFloat(k[4]));
  return { dates, prices };
}

// ---------- LINE 推播 ----------
async function pushLine(message){
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const userId = process.env.LINE_USER_ID;
  if(!token || !userId){
    throw new Error('缺少 LINE_CHANNEL_ACCESS_TOKEN 或 LINE_USER_ID 環境變數');
  }
  const res = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      to: userId,
      messages: [{ type: 'text', text: message }]
    })
  });
  if(!res.ok){
    const body = await res.text();
    throw new Error(`LINE 推播失敗 ${res.status}: ${body}`);
  }
}

const STRATEGY_NAMES = {
  sma: '均線交叉（20/50）',
  rsi: 'RSI 超買超賣（30/70）',
  macd: 'MACD 交叉',
  boll: '布林通道均值回歸'
};

// ---------- 主流程 ----------
async function checkTarget(target){
  let dates, prices, coinLabel;
  if(target.source === 'binance'){
    const r = await fetchBinance(target.binanceSymbol, target.interval, target.limit);
    dates = r.dates; prices = r.prices;
    coinLabel = `${target.label}（Binance ${target.interval}）`;
  } else {
    const r = await fetchCoinGecko(target.coinGeckoId, target.days);
    dates = r.dates; prices = r.prices;
    coinLabel = `${target.label}（CoinGecko 日線）`;
  }

  const { buySignal, sellSignal } = generateSignals(prices, target.strategy);
  const last = prices.length - 1;
  const baseKey = `${dates[last]}_${target.strategy}_${target.label}_${target.source}`;

  let direction = null;
  if(buySignal[last]) direction = 'buy';
  else if(sellSignal[last]) direction = 'sell';

  return { target, coinLabel, dates, prices, last, direction, baseKey };
}

async function main(){
  console.log('開始檢查訊號...', new Date().toISOString());

  if(TARGETS.length === 0){
    console.log('TARGETS 是空的，請先在程式最上面設定要監控的幣種。');
    return;
  }

  const state = loadState();
  const triggered = [];
  const errors = [];

  for(const target of TARGETS){
    try{
      const r = await checkTarget(target);
      if(!r.direction){
        console.log(`[${target.label}] 無新訊號，最新K棒時間：${r.dates[r.last]}`);
        continue;
      }
      const alertKey = r.baseKey + '_' + r.direction;
      if(state[target.label] === alertKey){
        console.log(`[${target.label}] 這個訊號已經通知過了，不重複發送。`);
        continue;
      }
      triggered.push({
        label: target.label,
        coinLabel: r.coinLabel,
        strategyName: STRATEGY_NAMES[target.strategy],
        direction: r.direction,
        date: r.dates[r.last],
        price: r.prices[r.last],
        alertKey
      });
    }catch(e){
      console.error(`[${target.label}] 檢查失敗：`, e.message);
      errors.push(`${target.label}：${e.message}`);
    }
  }

  if(triggered.length === 0){
    console.log('本次執行沒有任何幣種出現新訊號。');
    if(errors.length) console.log('但有錯誤：', errors.join('；'));
    return;
  }

  const lines = triggered.map(t=>{
    const dirLabel = t.direction === 'buy' ? '📈 買進' : '📉 賣出';
    return `${dirLabel}｜${t.coinLabel}｜${t.strategyName}\n時間：${t.date}　價格：$${t.price.toFixed(2)}`;
  });
  const message = `${lines.join('\n\n')}\n\n（僅為指標邏輯訊號，非投資建議，請自行判斷風險）`;

  await pushLine(message);
  console.log('已推播：', message);

  triggered.forEach(t => { state[t.label] = t.alertKey; });
  saveState(state);
}

main().catch(err => {
  console.error('執行失敗：', err);
  process.exit(1);
});
