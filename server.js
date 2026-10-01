const { generate } = require("otplib");
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const WebSocket = require("ws");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

const API_KEY = process.env.ANGEL_API_KEY;
const CLIENT_CODE = process.env.ANGEL_CLIENT_CODE;
const PIN = process.env.ANGEL_PIN;
const TOTP_SECRET = process.env.ANGEL_TOTP;

const MAC_ADDRESS = "c8:a1:dc:bb:e4:f3";

let session = null;
let feedWs = null;
let latest = {};
let heartbeatTimer = null;

async function loginAngel() {
  if (!API_KEY || !CLIENT_CODE || !PIN || !TOTP_SECRET) {
    throw new Error("Angel One details missing in .env");
  }

  const response = await fetch(
    "https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-UserType": "USER",
        "X-SourceID": "WEB",
        "X-PrivateKey": API_KEY,
        "X-MACaddress": MAC_ADDRESS
      },
      body: JSON.stringify({
        clientcode: CLIENT_CODE,
        password: PIN,
        totp: await generate({ secret: TOTP_SECRET })
      })
    }
  );

  const data = await response.json();

  console.log("Angel login response:", {
    status: data.status,
    message: data.message
  });

  if (!data.status) {
    throw new Error(data.message || "Angel One login failed");
  }

  session = data.data;

  return {
    ok: true,
    message: "Angel One login successful",
    feedToken: Boolean(session.feedToken)
  };
}

function parseLtpPacket(message) {
  const buf = Buffer.isBuffer(message)
    ? message
    : Buffer.from(message);

  if (buf.length < 51) return null;

  if (buf.toString("utf8") === "pong") return null;

  const mode = buf.readUInt8(0);
  const exchangeType = buf.readUInt8(1);

  const tokenRaw = buf
    .subarray(2, 27)
    .toString("utf8");

  const token = tokenRaw
    .replace(/\0/g, "")
    .trim();

  const ltpRaw = buf.readBigUInt64LE(43);
  const ltp = Number(ltpRaw) / 100;

  return {
    mode,
    exchangeType,
    token,
    ltp,
    receivedAt: new Date().toISOString()
  };
}

function stopFeed() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  if (feedWs) {
    try {
      feedWs.close();
    } catch (_) {}

    feedWs = null;
  }
}

function startFeed(tokens = []) {
  if (!session?.feedToken || !session?.jwtToken) {
    throw new Error("Login to Angel One first");
  }

  stopFeed();

  const tokenList = tokens.length
    ? tokens
    : [
        {
          exchangeType: 1,
          tokens: ["99926000"]
        }
      ];

  const url =
    "wss://smartapisocket.angelone.in/smart-stream" +
    "?clientCode=" + encodeURIComponent(CLIENT_CODE) +
    "&feedToken=" + encodeURIComponent(session.feedToken) +
    "&apiKey=" + encodeURIComponent(API_KEY);

  feedWs = new WebSocket(url);

  feedWs.on("open", () => {
    console.log("Angel One market feed connected");

    const subscription = {
      correlationID: "friendtrade",
      action: 1,
      params: {
        mode: 1,
        tokenList
      }
    };

    feedWs.send(JSON.stringify(subscription));

    heartbeatTimer = setInterval(() => {
      if (feedWs?.readyState === WebSocket.OPEN) {
        feedWs.send("ping");
      }
    }, 30000);
  });

  feedWs.on("message", (message) => {
    const tick = parseLtpPacket(message);

    if (!tick || !tick.token) return;

    latest[tick.token] = tick;

    console.log("LTP:", tick.token, tick.ltp);
  });

  feedWs.on("error", (error) => {
    console.error("Feed error:", error.message);
  });

  feedWs.on("close", () => {
    console.log("Angel One market feed closed");

    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  });
}

app.post("/api/login", async (_req, res) => {
  try {
    const result = await loginAngel();
    res.json(result);
  } catch (error) {
    console.error("Login error:", error.message);
    res.status(400).json({
      ok: false,
      error: error.message
    });
  }
});

app.post("/api/start-feed", (req, res) => {
  try {
    startFeed(req.body?.tokenList || []);
    res.json({
      ok: true,
      message: "Market feed started"
    });
  } catch (error) {
    console.error("Feed start error:", error.message);
    res.status(400).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/api/status", (_req, res) => {
  res.json({
    ok: true,
    loggedIn: Boolean(session?.jwtToken),
    feedConnected: Boolean(
      feedWs && feedWs.readyState === WebSocket.OPEN
    ),
    latest
  });
});



// ==================== PAPER TRADING ====================
let paper = {
  balance: 100000,
  holdings: {},
  orders: [],
  realizedPnl: 0
};

app.get("/api/paper/status", (_req, res) => {
  const tick = latest["99926000"];
  const price = tick ? Number(tick.ltp) : 0;

  let holdingsValue = 0;
  for (const symbol of Object.keys(paper.holdings)) {
    const h = paper.holdings[symbol];
    holdingsValue += h.qty * price;
  }

  res.json({
    ok: true,
    balance: Number(paper.balance.toFixed(2)),
    holdings: paper.holdings,
    holdingsValue: Number(holdingsValue.toFixed(2)),
    totalValue: Number((paper.balance + holdingsValue).toFixed(2)),
    currentPrice: price,
    realizedPnl: Number(paper.realizedPnl.toFixed(2)),
    unrealizedPnl: Number(
      Object.values(paper.holdings)
        .reduce((sum, h) => sum + ((price - h.avgPrice) * h.qty), 0)
        .toFixed(2)
    ),
    totalPnl: Number((
      paper.realizedPnl +
      Object.values(paper.holdings)
        .reduce((sum, h) => sum + ((price - h.avgPrice) * h.qty), 0)
    ).toFixed(2)),
    orders: paper.orders
  });
});

app.post("/api/paper/order", (req, res) => {
  const side = String(req.body?.side || "").toUpperCase();
  const qty = Number(req.body?.qty);

  if (!["BUY", "SELL"].includes(side)) {
    return res.status(400).json({ok:false, error:"Side must be BUY or SELL"});
  }

  if (!Number.isInteger(qty) || qty <= 0) {
    return res.status(400).json({ok:false, error:"Quantity must be a positive whole number"});
  }

  const tick = latest["99926000"];
  if (!tick || !Number(tick.ltp)) {
    return res.status(400).json({ok:false, error:"Live NIFTY price not available"});
  }

  const price = Number(tick.ltp);
  const symbol = "NIFTY 50";
  const holding = paper.holdings[symbol] || {qty:0, avgPrice:0};

  if (side === "BUY") {
    const cost = price * qty;

    if (cost > paper.balance) {
      return res.status(400).json({ok:false, error:"Insufficient paper balance"});
    }

    const oldQty = holding.qty;
    const newQty = oldQty + qty;
    const newAvg = oldQty === 0
      ? price
      : ((oldQty * holding.avgPrice) + cost) / newQty;

    paper.balance -= cost;
    paper.holdings[symbol] = {
      qty: newQty,
      avgPrice: Number(newAvg.toFixed(2))
    };
  } else {
    if (holding.qty < qty) {
      return res.status(400).json({ok:false, error:"Not enough paper holdings"});
    }

    paper.balance += price * qty;

    // Realized P&L on paper SELL
    paper.realizedPnl += (price - holding.avgPrice) * qty;

    holding.qty -= qty;

    if (holding.qty === 0) {
      delete paper.holdings[symbol];
    } else {
      paper.holdings[symbol] = holding;
    }
  }

  const order = {
    id: paper.orders.length + 1,
    symbol,
    side,
    qty,
    price,
    time: new Date().toISOString()
  };

  paper.orders.unshift(order);

  res.json({ok:true, message:"Paper order executed", order});
});
// =======================================================

app.listen(PORT, () => {
  console.log(`FriendTrade running at http://localhost:${PORT}`);
});
