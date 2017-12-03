const config = require("../config.json");
const tradeConfig = require("../config/trading").config;
const common = require("./common");
const db = require("./db");
const bittrex = require("./bittrex");

const co = require("co");

function* makeRequest(data) {
	// set up the options for the request
	const method = data.method ? data.method : "GET";
	if (!data.params) {
		data.params = {};
	}
	data.params["apikey"] = config.bittrex.key;
	const nonce = new Date().getTime();
	data.params["nonce"] = nonce;
	const paramString = querystring.stringify(data.params);
	const uri = `${data.url}?${paramString}`;
	let headers = {
		"Content-Type": "application/json; charset=utf-8",
		// eslint-disable-next-line
		"apisign": crypto.HmacSHA512(uri, config.bittrex.secret)
	};
	if (data.headers) {
		headers = data.headers;
	}
	const options = {
		method: method,
		uri: uri,
		json: true,
		headers: headers
	};
	// go out and actually get the data
	let returnObj;
	try {
		returnObj = yield rp(options);
	} catch (err) {
		throw new Error(err);
	}
	return returnObj;
}

const buySignal = function* buySignal(signal, options = null) {
	const defaults = {
		portfolio: "portfolio",
		trades: common.db.trades,
		marketDoc: null,
		now: new Date().getTime()
	};
	if (options === null) {
		options = defaults;
	} else {
		options = Object.assign(defaults, options);
	}
	common.log("verbose", `. Got signal for ${signal.pair}`);
	// now start to make trades
	let portfolio = yield db.getDocument(options.portfolio, common.db.portfolios);
	// check to see if we're trading
	if (portfolio.active !== true) {
		common.log("warn", "! Trading disabled, discarding signal");
		return false;
	}
	if (portfolio.live !== tradeConfig.live) {
		common.log("warn", "! Trading mode doesn't match portfolio");
		return false;
	}
	if (portfolio.balance <= tradeConfig.min_balance) {
		common.log("warn", `- Balance at limit: ${portfolio.balance}`);
		return false;
	}
	if (portfolio.blacklist[signal.pair]) {
		const minutes = (portfolio.blacklist[signal.pair] - options.now) / 1000 / 60;
		common.log("warn", `- Position ${signal.pair} on blacklist for ${minutes.toFixed(2)} minutes`);
		return false;
	}
	const openPositions = Object.keys(portfolio.positions).length;
	if (openPositions > tradeConfig.max_positions) {
		common.log("debug", `- Too many open positions ${openPositions}`);
		return false;
	}
	if (portfolio.positions[signal.pair]) {
		common.log("debug", `- Already have position in ${signal.pair}`);
		return false;
	}
	// start calculating potential costs
	// if we have more money than the max order price, use the order price, if not, use the balance - mins
	let allMarkets;
	// for injecting your own summary
	if (options.marketDoc === null) {
		allMarkets = yield bittrex.getAllMarkets();
	} else {
		allMarkets = options.marketDoc;
	}
	// set prices dynamically depending on configuration
	let prices;
	if (signal.price !== "A" && signal.qty !== "A") {
		prices = {
			per: common.bitRound(signal.price),
			purchase: (portfolio.balance > (signal.price * signal.qty)) ? (signal.price * signal.qty) : (portfolio.balance - tradeConfig.min_balance)
		};
	} else {
		prices = {
			per: common.bitRound(allMarkets[signal.pair].summary["Ask"]),
			purchase: (portfolio.balance > (tradeConfig.max_position_price)) ? (tradeConfig.max_position_price) : (portfolio.balance - tradeConfig.min_balance)
		};
	}
	// do the trade
	const trade = yield makeBuyTrade(portfolio, signal, {
		prices: prices,
		options: options
	});
	// adjust our portfolio
	portfolio = adjustBuyTrade(portfolio, trade.data);
	yield db.saveDocument(portfolio, common.db.portfolios);
	return trade.message;
};

const updateData = function* updateData(options = null) {
	const defaults = {
		portfolio: "portfolio",
		trades: common.db.trades,
		marketDoc: null,
		now: new Date().getTime()
	};
	if (options === null) {
		options = defaults;
	} else {
		options = Object.assign(defaults, options);
	}
	common.log("verbose", `. Performing data updates for ${options.now}`);
	let portfolio = yield db.getDocument(options.portfolio, common.db.portfolios);
	if (portfolio.live !== tradeConfig.live) {
		common.log("warn", "! Trading mode doesn't match portfolio");
		throw new Error("Trading mode doesn't match portfolio");
	}
	// change reserved trades into completed
	if (tradeConfig.live === true) {
		portfolio = yield resolveTrades(portfolio);
	}
	// loop through each positions
	let allMarkets;
	// for injecting your own summary
	if (options.marketDoc === null) {
		allMarkets = yield bittrex.getAllMarkets();
	} else {
		allMarkets = options.marketDoc;
	}

	// check to manage activeness
	if (portfolio.active !== true) {
		// if for any reason we're not actively trading
		common.log("warn", "! Trading disabled, monitoring only");
		if (portfolio.active !== false) {
			if (portfolio.active - options.now <= 0) {
				portfolio.active = true;
				common.log("info", ". Volitility timeout is over, resuming trading");
			} else {
				common.log("info", `. Trading will resume in ${portfolio.active - options.now}ms`);
			}
		}
	}

	// manage the blacklist
	for (const item in portfolio.blacklist) {
		if (options.now > portfolio.blacklist[item]) {
			delete portfolio.blacklist[item];
		}
	}

	// we are actively trading, check prices and crashes
	let delta;
	if (allMarkets["USDT-BTC"].summary["Bid"] === 0 || portfolio.usdbtc === 0) {
		delta = 0;
	} else {
		delta = (allMarkets["USDT-BTC"].summary["Bid"] - portfolio.usdbtc) / portfolio.usdbtc;
	}
	if (delta >= tradeConfig.max_volitility || delta <= (tradeConfig.max_volitility * -1)) {
		common.log("warn", `! USDT-BTC Crash detected! [${delta}%]`);
		portfolio.active = options.now + tradeConfig.volitility_timeout;
	}
	// set with the new price
	portfolio.usdbtc = allMarkets["USDT-BTC"].summary["Bid"];

	// parse the order book if we need to be monitoring
	for (const position in portfolio.positions) {
		const isMonitoring = portfolio.positions[position].meta.secure === true && tradeConfig.order_parsing === true;
		// set to null and use as a default if not monitoring
		let orderBookStats = null;
		if (isMonitoring === true) {
			const orderBook = yield bittrex.getOrderBook(position);
			orderBookStats = bittrex.getOrderBookStats(orderBook, {
				qty: portfolio.positions[position].units
			});
			common.log("debug", `. Monitoring is enabled for ${position} - spreadAsk: ${orderBookStats.tpSpreadAskPerc.toFixed(4)} / spreadAvg: ${orderBookStats.tpSpreadAvgPerc.toFixed(4)}`);
		}
		portfolio.positions[position].orders = orderBookStats;
	}

	// save portfolio before continuing
	yield db.saveDocument(portfolio, common.db.portfolios);
	return allMarkets;
};

const updatePositions = function* updatePositions(options = null) {
	const defaults = {
		portfolio: "portfolio",
		trades: common.db.trades,
		marketDoc: null,
		now: new Date().getTime()
	};
	if (options === null) {
		options = defaults;
	} else {
		options = Object.assign(defaults, options);
	}
	common.log("verbose", `. Performing position updates for ${options.now}`);
	let portfolio = yield db.getDocument(options.portfolio, common.db.portfolios);
	if (portfolio.live !== tradeConfig.live) {
		common.log("warn", "! Trading mode doesn't match portfolio");
		return false;
	}
	// loop through each positions
	let allMarkets;
	// for injecting your own summary
	if (options.marketDoc === null) {
		allMarkets = yield bittrex.getAllMarkets();
	} else {
		allMarkets = options.marketDoc;
	}
	// check all positions
	const messages = [];
	for (const position in portfolio.positions) {
		// freshness checks go here
		const ageResult = agePosition(portfolio.positions[position], options);
		const prices = {
			per: common.bitRound(allMarkets[position].summary["Bid"]),
			profit: ageResult.profit,
			loss: ageResult.loss,
			last: portfolio.positions[position].current
		};
		// are we monitoring this
		const isMonitoring = portfolio.positions[position].meta.secure === true && tradeConfig.order_parsing === true;
		// if we're monitoring, let's get our "true" price per
		if (isMonitoring === true) {
			prices.per = portfolio.positions[position].orders.tpBidPrice;
		}
		// now update it
		portfolio.positions[position].current = prices.per;
		// is this position losing us money (or at least not making us money)
		const isLosing = portfolio.positions[position].current <= portfolio.positions[position].price;
		// is the spread very low
		const lowSpread = (prices.per > portfolio.positions[position].price) && (allMarkets[position].summary["Spread"] <= tradeConfig.spread_to_sell);

		const ticker = common.formatTicker(portfolio.positions[position], prices.per);
		// check to see if we should continue monitoring
		if (isMonitoring === true && isLosing === true) {
			portfolio.positions[position].meta.secure = false;
		}
		// check to see if we're trading
		if (portfolio.active !== true) {
			common.log("debug", `. Position: ${ticker}`);
			continue;
		}
		let isSelling = false;

		// we're going to make a profit, let's handle logic for that
		if (prices.per > prices.profit && isSelling === false) {
			// we're not doing monitoring for one reason or another
			const delta = (prices.per - prices.last) / portfolio.positions[position].price;
			// this was an increase, but not enough to sell, keep riding it
			if (lowSpread === true) {
				common.log("info", `+ Low spread for ${ticker} encountered, selling`);
			} else if (delta < tradeConfig.profit_increase_override) {
				prices.loss = common.bitRound(prices.per * (1 - tradeConfig.profit_slip));
				portfolio.positions[position].limits.loss = prices.loss;
				prices.profit = common.bitRound(prices.per * (1 + tradeConfig.profit_increase));
				portfolio.positions[position].limits.profit = prices.profit;
				// setting the flags
				portfolio.positions[position].meta.secure = true;
				portfolio.positions[position].meta.warning = false;
				common.log("info", `. Securing profit for ${ticker}, increasing new limit to ${prices.profit}`);
				continue;
			}
			common.log("info", `+ Profit increase target for ${ticker} exceeded, +${common.percent(delta)}% increase in one tick`);
		}

		// only prevent quick sell if it's a loss, like a REAL loss
		if (prices.per < prices.loss && prices.per < portfolio.positions[position].price && isSelling === false) {
			// this is going to be a loss
			if (ageResult.age < tradeConfig.initial_sell_delay) {
				common.log("warn", `. Preventing sell of ${ticker} for a loss because of age ${ageResult.age}`);
				continue;
			}
			if (portfolio.positions[position].meta.warning === false) {
				portfolio.positions[position].limits.loss = prices.per;
				portfolio.positions[position].meta.warning = true;
				common.log("warn", `. Putting ${ticker} on warning`);
				continue;
			}
		}

		// check if we're monitoring, and sell based on that
		if (isMonitoring === true) {
			const orderBook = portfolio.positions[position].orders;
			common.log("debug", `. Monitoring ${ticker} for orderbook changes`);
			// if we're monitoring the order book, do sell logic based on that ideally
			const spreadAskFlag = (orderBook.tpSpreadAskPerc <= tradeConfig.orders.spread_ask);
			const spreadAvgFlag = (orderBook.tpSpreadAvgPerc >= tradeConfig.orders.spread_avg);
			if (spreadAskFlag !== true || spreadAvgFlag !== true) {
				// they don't both match, check for instas
				const spreadAskInstaFlag = (orderBook.tpSpreadAskPerc <= tradeConfig.orders.spread_ask_insta);
				const spreadAvgInstaFlag = (orderBook.tpSpreadAvgPerc >= tradeConfig.orders.spread_avg_insta);
				// if no insta flags, bail
				if (spreadAskInstaFlag !== true && spreadAvgInstaFlag !== true) {
					continue;
				}
			}
			// our flags matched, we're selling
			common.log("info", `+ Selling ${ticker} based on orderbook conditions`);
			isSelling = true;
			// change our price to our order price
			prices.per = orderBook.tpBidOrderPrice;
		}

		// check for positions that are in limbo (between profit and loss)
		if (prices.per >= prices.loss && prices.per <= prices.profit && isSelling === false) {
			common.log("debug", `. Movement not large enough to sell: ${ticker}`);
			if (portfolio.positions[position].limits.profit !== prices.profit) {
				common.log("verbose", `. Position in ${position} has aged!`);
				portfolio.positions[position].limits.profit = prices.profit;
				portfolio.positions[position].limits.loss = prices.loss;
				// clear any warnings
				portfolio.positions[position].meta.warning = false;
			}
			continue;
		}
		// enforce a backoff for toxic assets
		const lossPerc = (prices.per - portfolio.positions[position].price) / portfolio.positions[position].price;
		if (lossPerc < 0) {
			const mod = lossPerc * -100;
			// if backoff is 3m and trade lost 5%, backoff is 15m
			const backoff = mod * tradeConfig.toxic_asset_backoff;
			portfolio.blacklist[position] = backoff + options.now;
			common.log("warn", `. Blacklisting ${ticker} for ${(backoff / 1000 / 60).toFixed(2)} minutes`);
		}
		// it's assumed after this point we need to sell
		// TODO: maybe offer something better than this?
		let trade;
		if (portfolio.positions[position].meta.status !== "filled") {
			common.log("info", `- Attempting to sell unfilled order ${ticker}, cancelling`);
			// do our trade
			trade = yield makeRefundTrade(portfolio, position, {
				options: options
			});
			portfolio = adjustRefundTrade(portfolio, trade.data);
		} else {
			trade = yield makeSellTrade(portfolio, position, {
				prices: prices,
				options: options
			});
			portfolio = adjustSellTrade(portfolio, trade.data);
		}
		messages.push(trade.message);
	}
	// save our portfolio
	yield db.saveDocument(portfolio, common.db.portfolios);
	return messages.length === 0 ? false : messages;
};

const parseSignals = (msg) => {
	const signals = [];
	const signalExp = /\^(\w+)\*(\w+-\w+)\*(A|\d?\.?\d+)\*(A|\d?\.?\d+)\*(.*)\^/i;
	const matches = signalExp.exec(msg.text);
	if (matches.length !== 6) {
		common.log("error", "! Bad message");
		return [];
	}
	const signal = {
		action: matches[1],
		pair: matches[2],
		qty: matches[3],
		price: matches[4],
		meta: matches[5]
	};
	signals.push(signal);
	return signals;
};

const purchase = function* purchase(pair, price, qty) {
	const options = {
		portfolio: "portfolio",
		trades: common.db.trades,
		marketDoc: null,
		now: new Date().getTime()
	};
	common.log("info", `. Purchasing position in ${pair} at ${price} for ${qty}`);
	let portfolio = yield db.getDocument(options.portfolio, common.db.portfolios);
	// change reserved trades into completed
	if (tradeConfig.live === true) {
		common.log("info", "! Purchasing LIVE position on Bittrex");
	}
	const signal = {
		action: "buy",
		pair: pair,
		qty: qty,
		price: price,
		meta: `${options.now}-command`
	};
	const trade = yield makeBuyTrade(portfolio, signal, {
		prices: {
			per: price,
			purchase: price * qty
		},
		options: options
	});
	// make adjustments
	portfolio = adjustBuyTrade(portfolio, trade.data);
	// save our portfolio
	yield db.saveDocument(portfolio, common.db.portfolios);
	return trade.message;
};

const liquidate = function* liquidate(position, price) {
	const options = {
		portfolio: "portfolio",
		trades: common.db.trades,
		marketDoc: null,
		now: new Date().getTime(),
		liquidate: true
	};
	common.log("info", `. Liquidating position in ${position} for ${price}`);
	let portfolio = yield db.getDocument(options.portfolio, common.db.portfolios);
	// change reserved trades into completed
	if (tradeConfig.live === true) {
		common.log("info", "! Liquidating LIVE position on Bittrex");
	}
	const trade = yield makeSellTrade(portfolio, position, {
		prices: {
			per: price,
			profit: null,
			loss: null
		},
		options: options
	});
	// make adjustments
	portfolio = adjustSellTrade(portfolio, trade.data);
	// save our portfolio
	yield db.saveDocument(portfolio, common.db.portfolios);
	return trade.message;
};

const writeoff = function* writeoff(position) {
	const options = {
		portfolio: "portfolio",
		trades: common.db.trades,
		marketDoc: null,
		now: new Date().getTime(),
		liquidate: true
	};
	common.log("info", `. Writing off position in ${position}`);
	let portfolio = yield db.getDocument(options.portfolio, common.db.portfolios);
	// make the trade
	const trade = yield makeWriteoffTrade(portfolio, position, {
		options: options
	});
	// make adjustments
	portfolio = adjustWriteoffTrade(portfolio, trade.data);
	// save our portfolio
	yield db.saveDocument(portfolio, common.db.portfolios);
	return trade.message;
};

const halt = function* halt() {
	const options = {
		portfolio: "portfolio"
	};
	common.log("info", ". Halting trading, monitor only");
	const portfolio = yield db.getDocument(options.portfolio, common.db.portfolios);
	portfolio.active = false;
	const confirmation = yield db.saveDocument(portfolio, common.db.portfolios);
};

const resume = function* resume() {
	const options = {
		portfolio: "portfolio"
	};
	common.log("info", ". Resuming trading");
	const portfolio = yield db.getDocument(options.portfolio, common.db.portfolios);
	portfolio.active = true;
	const confirmation = yield db.saveDocument(portfolio, common.db.portfolios);
};

module.exports = {
	buySignal: buySignal,
	updateData: updateData,
	updatePositions: updatePositions,
	parseSignals: parseSignals,
	writeoff: writeoff,
	purchase: purchase,
	liquidate: liquidate,
	halt: halt,
	resume: resume
};

function adjustWriteoffTrade(portfolio, trade) {
	delete portfolio.positions[trade.pair];
	portfolio.balance -= trade.cost;
	return portfolio;
}

function adjustRefundTrade(portfolio, trade) {
	delete portfolio.positions[trade.pair];
	portfolio.balance -= trade.cost;
	return portfolio;
}

function adjustBuyTrade(portfolio, trade) {
	// adjust our portfolio
	portfolio.balance -= trade.cost;
	portfolio.positions[trade.pair] = trade;
	return portfolio;
}

function adjustSellTrade(portfolio, trade) {
	// save our trade
	delete portfolio.positions[trade.pair];
	if (tradeConfig.live === true) {
		// actual trade here
		portfolio.pending[trade.pair] = trade;
	} else {
		// we don't actually want to give the money back if it's not live
		portfolio.balance -= trade.cost;
	}
	return portfolio;
}

function* resolveTrades(portfolio) {
	if (portfolio.positions.length === 0 && portfolio.pending.length === 0) {
		return;
	}
	const orders = yield bittrex.getOpenOrders();
	const trades = [];
	// cycle through all current holdings (pending buy positions included)
	for (const position in portfolio.positions) {
		const positionObj = portfolio.positions[position];
		if (positionObj.meta.status === "reserved") {
			const index = orders.map((x) => {return x["OrderUuid"];}).indexOf(positionObj.meta.uuid);
			if (index === -1) {
				common.log("info", `+ Position ${position} for trade ${positionObj._id} filled!`);
				// update the trade
				trades.push(fillTrade(positionObj._id));
				// update the portfolio
				portfolio.positions[position].meta.status = "filled";
			}
		}
	}
	// cycle through all pending sells (real trading only)
	for (const position in portfolio.pending) {
		const positionObj = portfolio.pending[position];
		if (positionObj.meta.status === "reserved") {
			const index = orders.map((x) => {return x["OrderUuid"];}).indexOf(positionObj.meta.uuid);
			if (index === -1) {
				common.log("info", `+ Position ${position} for trade ${positionObj._id} filled!`);
				// update the trade
				trades.push(fillTrade(positionObj._id));
				// update the portfolio
				portfolio.balance -= portfolio.pending[position].cost;
				delete portfolio.pending[position];
			}
		}
	}
	// actually execute the trades
	for (const trade of trades) {
		yield trade;
	}
	return portfolio;

	function* fillTrade(id) {
		const doc = yield db.getDocument(id, common.db.trades);
		doc.meta.status = "filled";
		yield db.saveDocument(doc, common.db.trades);
		common.log("debug", `. Updated trade ${doc._id}`);
	}
}

function* makeWriteoffTrade(portfolio, position, data) {
	const writeOffId = portfolio.positions[position]._id.split("-").shift();
	const trade = {
		_id: `${writeOffId}-writeoff`,
		created: data.options.now.toString(),
		pair: portfolio.positions[position].pair,
		price: portfolio.positions[position].price,
		units: portfolio.positions[position].units,
		cost: portfolio.positions[position].cost * -1,
		meta: {
			status: "writeoff",
			uuid: portfolio.positions[position].meta.uuid
		}
	};
	// save our docs
	yield db.saveDocument(trade, data.options.trades);
	const message = `Writeoff ${trade.pair} - ${trade.units} @ ${trade.price} BTC`;
	common.log("info", `+ Completed trade [${trade._id}]`);
	common.log("info", `. ${message}`);
	return {
		data: trade,
		message: `[${trade._id}] ${message}`
	};
}

function* makeRefundTrade(portfolio, position, data) {
	const refundId = portfolio.positions[position]._id.split("-").shift();
	const trade = {
		_id: `${refundId}-refund`,
		created: data.options.now.toString(),
		pair: portfolio.positions[position].pair,
		price: portfolio.positions[position].price,
		units: portfolio.positions[position].units,
		cost: portfolio.positions[position].cost * -1,
		meta: {
			status: "refunded",
			uuid: portfolio.positions[position].meta.uuid
		}
	};
	if (tradeConfig.live === true) {
		// actuall trade here
		const confirmation = yield bittrex.cancel(trade.meta.uuid);
		common.log("verbose", `+ Order ${trade.meta.uuid} cancelled ${confirmation}`);
	}
	// save our docs
	yield db.saveDocument(trade, data.options.trades);
	const message = `Refund ${trade.pair} - ${trade.units} @ ${trade.price} BTC`;
	common.log("info", `+ Completed trade [${trade._id}]`);
	common.log("info", `. ${message}`);
	return {
		data: trade,
		message: `[${trade._id}] ${message}`
	};
}

function* makeBuyTrade(portfolio, signal, data) {
	const trade = {
		_id: `${signal.meta}-buy`,
		created: data.options.now.toString(),
		pair: signal.pair,
		price: data.prices.per,
		units: data.prices.purchase / data.prices.per,
		limits: {
			loss: common.bitRound(data.prices.per * (1 - tradeConfig.limits.fresh.loss)),
			profit: common.bitRound(data.prices.per * (1 + tradeConfig.limits.fresh.profit))
		},
		cost: data.prices.purchase * (1 + tradeConfig.fee),
		profit: null,
		meta: {
			warning: false,
			secure: false,
			status: tradeConfig.live === true ? "created" : "filled",
			uuid: null
		}
	};
	if (tradeConfig.live === true) {
		// actuall trade here
		const confirmation = yield bittrex.buy(trade.pair, trade.units, trade.price);
		trade.meta.status = "reserved";
		trade.meta.uuid = confirmation.uuid;
		common.log("info", `+ Placing LIVE buy trade on Bittrex: ${trade.pair}`);
	}
	// save our docs
	yield db.saveDocument(trade, data.options.trades);
	const message = `Buy ${trade.pair} - ${trade.units} @ ${trade.price} - ${trade.cost} BTC`;
	common.log("info", `+ Completed trade [${trade._id}]`);
	common.log("info", `. ${message}`);
	return {
		data: trade,
		message: `[${trade._id}] ${message}`
	};
}

function* makeSellTrade(portfolio, position, data) {
	const sellId = portfolio.positions[position]._id.split("-").shift();
	const trade = {
		_id: `${sellId}-sell`,
		created: data.options.now.toString(),
		pair: portfolio.positions[position].pair,
		price: data.prices.per,
		units: portfolio.positions[position].units,
		limits: {
			loss: data.prices.loss,
			profit: data.prices.profit
		},
		cost: ((portfolio.positions[position].units * data.prices.per) * (1 - tradeConfig.fee)) * -1,
		meta: {
			warning: portfolio.positions[position].meta.warning,
			secure: portfolio.positions[position].meta.secure,
			status: "created",
			uuid: null,
			liquidated: data.liquidated ? true : false
		}
	};
	trade.profit = {
		amount: common.bitRound(trade.cost + portfolio.positions[position].cost) * -1
	};
	trade.profit.percentage = Math.round(trade.profit.amount / portfolio.positions[position].cost * 10000) / 10000;
	// save our trade
	if (tradeConfig.live === true) {
		// actual trade here
		const confirmation = yield bittrex.sell(trade.pair, trade.units, trade.price);
		trade.meta.status = "reserved";
		trade.meta.uuid = confirmation.uuid;
		common.log("info", `+ Placing LIVE sell trade on Bittrex: ${trade.pair}`);
	}
	// save our docs
	yield db.saveDocument(trade, data.options.trades);
	const message = `Sell ${trade.pair} - ${trade.units} @ ${trade.price} - Profit: ${trade.profit.amount} [${(trade.profit.percentage * 100).toFixed(3)}%] BTC`;
	common.log("info", `+ Completed trade [${trade._id}]`);
	common.log("info", `. ${message}`);
	return {
		data: trade,
		message: `[${trade._id}] ${message}`
	};
}

function agePosition(position, options) {
	const age = options.now - parseInt(position.created);
	// check if we have a flag set
	if (position.meta.warning === true || position.meta.secure === true) {
		return {
			age: age,
			loss: position.limits.loss,
			profit: position.limits.profit
		};
	}
	let lossPrice;
	let profitPrice;
	// setting loss and profit price depending on age of position
	if (age <= tradeConfig.limits.fresh.time) {
		common.log("silly", `. Position in ${position.pair} is ${age} and fresh`);
		lossPrice = common.bitRound(position.price * (1 - tradeConfig.limits.fresh.loss));
		profitPrice = common.bitRound(position.price * (1 + tradeConfig.limits.fresh.profit));
	} else if (age <= tradeConfig.limits.stale.time) {
		common.log("silly", `. Position in ${position.pair} is ${age} and stale`);
		lossPrice = common.bitRound(position.price * (1 - tradeConfig.limits.stale.loss));
		profitPrice = common.bitRound(position.price * (1 + tradeConfig.limits.stale.profit));
	} else {
		common.log("silly", `. Position in ${position.pair} is ${age} and old`);
		lossPrice = common.bitRound(position.price * (1 - tradeConfig.limits.old.loss));
		profitPrice = common.bitRound(position.price * (1 + tradeConfig.limits.old.profit));
	}
	return {
		age: age,
		loss: lossPrice,
		profit: profitPrice
	};
}
