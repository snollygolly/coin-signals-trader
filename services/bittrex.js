const config = require("../config.json");

const common = require("./common");
const bluebird = require("bluebird");
const co = require("co");
const crypto = require("crypto-js");
const querystring = require("querystring");
const rp = require("request-promise");
const moment = require("moment");

const baseUrl = "https://bittrex.com/api/v1.1/public";
const accountUrl = "https://bittrex.com/api/v1.1/account";
const marketUrl = "https://bittrex.com/api/v1.1/market";

module.exports = {
	getAllMarkets: function* getAllMarkets() {
		const summaries = yield makeRequest({
			url: `${baseUrl}/getmarketsummaries`,
			api: {
				key: config.bittrex.api_key,
				secret: config.bittrex.api_secret
			}
		});
		if (summaries.success !== true) {
			throw new Error(summaries.message);
		}
		return module.exports.processAllMarkets(summaries);
	},
	processAllMarkets: (summaries) => {
		// start building our final object
		const returnObj = {};
		for (const summary of summaries.result) {
			returnObj[summary["MarketName"]] = {};
			returnObj[summary["MarketName"]].summary = summary;
			// start building out our own stats
			returnObj[summary["MarketName"]].summary["Spread"] = summary["Ask"] - summary["Bid"];
			returnObj[summary["MarketName"]].summary["SpreadPercentage"] = (summary["Ask"] - summary["Bid"]) / summary["Ask"];
			const lowOffset = summary["Ask"] - summary["Low"];
			const priceRange = summary["High"] - summary["Low"];
			returnObj[summary["MarketName"]].summary["HighPercentage"] = lowOffset / priceRange;
		}
		return returnObj;
	},
	getOrderBook: function* getOrderBook(pair) {
		const orders = yield makeRequest({
			url: `${baseUrl}/getorderbook`,
			params: {
				market: pair,
				type: "both"
			},
			api: {
				key: config.bittrex.api_key,
				secret: config.bittrex.api_secret
			}
		});
		// check for errors
		if (orders.success !== true) {
			throw new Error(orders.message);
		}
		// TODO: make this more dynamic?
		const depth = 10;
		const returnObj = {
			bid: {qty: 0, rate: 0, data: []},
			ask: {qty: 0, rate: 0, data: []},
			spread: 0
		};
		let i = 0;
		while (i < depth) {
			// bid
			returnObj.bid.qty += orders.result.buy[i]["Quantity"];
			returnObj.bid.rate += orders.result.buy[i]["Rate"] * orders.result.buy[i]["Quantity"];
			returnObj.bid.data.push(orders.result.buy[i]);
			// ask
			returnObj.ask.qty += orders.result.sell[i]["Quantity"];
			returnObj.ask.rate += orders.result.sell[i]["Rate"] * orders.result.sell[i]["Quantity"];
			returnObj.ask.data.push(orders.result.sell[i]);
			i++;
		}
		returnObj.bid.rate /= returnObj.bid.qty;
		returnObj.ask.rate /= returnObj.ask.qty;
		returnObj.spread = (returnObj.ask.rate - returnObj.bid.rate) / returnObj.ask.rate;
		return returnObj;
	},
	getOrderBookStats: (book, data) => {
		// tp = total position sell price, how much we can sell all we're holding for
		const returnObj = {
			tpBidCost: 0,
			tpBidPrice: 0,
			tpBidOrderPrice: 0,
			tpAskCost: 0,
			tpAskPrice: 0,
			tpAskOrderPrice: 0,
			tpSpreadAsk: 0,
			tpSpreadAskPerc: 0,
			tpSpreadAvg: 0,
			tpSpreadAvgPerc: 0
		};
		let unitsLeft = data.qty;
		let i = 0;
		while (i < book.bid.data.length && unitsLeft > 0) {
			const order = book.bid.data[i];
			// decide how much of this order to fill
			if (order["Quantity"] >= unitsLeft) {
				// this order is larger than (or exactly the right size...) what we need
				returnObj.tpBidCost += unitsLeft * order["Rate"];
				unitsLeft = 0;
				// set the price we'll set the order for
				returnObj.tpBidOrderPrice = order["Rate"];
			} else {
				// we're taking all this order, but we need more after this
				returnObj.tpBidCost += order["Quantity"] * order["Rate"];
				unitsLeft -= order["Quantity"];
			}
			i++;
		}
		// summarize tpBid
		returnObj.tpBidPrice = common.bitRound(returnObj.tpBidCost / data.qty);

		unitsLeft = data.qty;
		i = 0;
		while (i < book.ask.data.length - 1 && unitsLeft > 0) {
			const order = book.ask.data[i];
			// decide how much of this order to fill
			if (order["Quantity"] >= unitsLeft) {
				// this order is larger than what we need
				returnObj.tpAskCost += unitsLeft * order["Rate"];
				unitsLeft = 0;
				// set the price we'll set the order for
				returnObj.tpAskOrderPrice = order["Rate"];
			} else {
				// we're taking all this order, but we need more after this
				returnObj.tpAskCost += order["Quantity"] * order["Rate"];
				unitsLeft -= order["Quantity"];
			}
			i++;
		}
		// summarize tpAsk
		returnObj.tpAskPrice = common.bitRound(returnObj.tpAskCost / data.qty);
		// calculate spreads
		returnObj.tpSpreadAsk = common.bitRound(returnObj.tpAskPrice - returnObj.tpBidPrice);
		returnObj.tpSpreadAskPerc = returnObj.tpSpreadAsk / returnObj.tpAskPrice;
		returnObj.tpSpreadAvg = common.bitRound(returnObj.tpBidPrice - book.bid.rate);
		returnObj.tpSpreadAvgPerc = returnObj.tpSpreadAvg / book.bid.rate;
		return returnObj;
	},
	generateDeltas: (oldDoc, newDoc) => {
		const delta = {
			"VolumePercentage": 0,
			"SpreadPercentage": 0,
			"Last": 0,
			"LastPercentage": 0,
			"Bid": 0,
			"BidPercentage": 0,
			"Ask": 0,
			"AskPercentage": 0
		};
		if (!oldDoc) {return delta;}
		delta["VolumePercentage"] = (newDoc.summary["Volume"] - oldDoc.summary["Volume"]) / oldDoc.summary["Volume"];
		delta["SpreadPercentage"] = newDoc.summary["SpreadPercentage"] - oldDoc.summary["SpreadPercentage"];
		delta["Last"] = newDoc.summary["Last"] - oldDoc.summary["Last"];
		delta["LastPercentage"] = (newDoc.summary["Last"] - oldDoc.summary["Last"]) / oldDoc.summary["Last"];
		delta["Bid"] = newDoc.summary["Bid"] - oldDoc.summary["Bid"];
		// to resolve getting bids back that are 0
		if (oldDoc.summary["Bid"] === 0) {
			delta["BidPercentage"] = 0;
		} else {
			delta["BidPercentage"] = (newDoc.summary["Bid"] - oldDoc.summary["Bid"]) / oldDoc.summary["Bid"];
		}
		delta["Bid"] = newDoc.summary["Bid"] - oldDoc.summary["Bid"];
		// to resolve getting asks back that are 0
		if (oldDoc.summary["Ask"] === 0) {
			delta["AskPercentage"] = 0;
		} else {
			delta["AskPercentage"] = (newDoc.summary["Ask"] - oldDoc.summary["Ask"]) / oldDoc.summary["Ask"];
		}
		return delta;
	},
	getCoinSummary: function* getCoinSummary(pair) {
		const summary = yield makeRequest({
			url: `${baseUrl}/getticker`,
			params: {
				market: pair
			},
			api: {
				key: config.bittrex.api_key,
				secret: config.bittrex.api_secret
			}
		});
		// check for errors
		if (summary.success !== true) {
			throw new Error(summary.message);
		}
		return summary.result;
	},
	getMarketSentiment: function* getMarketSentiment(pair) {
		const history = yield makeRequest({
			url: `${baseUrl}/getmarkethistory`,
			params: {
				market: pair
			},
			api: {
				key: config.bittrex.api_key,
				secret: config.bittrex.api_secret
			}
		});
		// check for errors
		if (history.success !== true) {
			throw new Error(history.message);
		}
		const returnObj = {
			buys: 0,
			buyAmount: 0,
			buyPercentage: 0,
			sells: 0,
			sellAmount: 0,
			sellPercentage: 0,
			totals: 0,
			totalAmount: 0
		};
		const minimum = moment(new Date()).subtract(10, "m");
		for (const purchase of history.result) {
			if (moment(new Date(purchase["TimeStamp"])).isBefore(minimum)) {
				break;
			}
			// add to return object
			if (purchase["OrderType"] === "BUY") {
				returnObj.buys++;
				returnObj.buyAmount += purchase["Total"];
			} else if (purchase["OrderType"] === "SELL") {
				returnObj.sells++;
				returnObj.sellAmount += purchase["Total"];
			}
			returnObj.totals++;
			returnObj.totalAmount += purchase["Total"];
		}
		returnObj.buyPercentage = returnObj.buyAmount / returnObj.totalAmount;
		returnObj.sellPercentage = returnObj.sellAmount / returnObj.totalAmount;
		return returnObj;
	},
	getBalance: function* getBalance(currency = "BTC") {
		const balance = yield makeRequest({
			url: `${accountUrl}/getbalance`,
			params: {
				currency: currency
			},
			api: {
				key: config.bittrex.api_key,
				secret: config.bittrex.api_secret
			}
		});
		// check for errors
		if (balance.success !== true) {
			throw new Error(balance.message);
		}
		return balance.result;
	},
	buy: function* buy(pair, qty, rate) {
		const confirmation = yield makeRequest({
			url: `${marketUrl}/buylimit`,
			params: {
				market: pair,
				quantity: qty,
				rate: rate
			},
			api: {
				key: config.bittrex.api_key,
				secret: config.bittrex.api_secret
			}
		});
		// check for errors
		if (confirmation.success !== true) {
			throw new Error(confirmation.message);
		}
		return confirmation.result;
	},
	sell: function* sell(pair, qty, rate) {
		const confirmation = yield makeRequest({
			url: `${marketUrl}/selllimit`,
			params: {
				market: pair,
				quantity: qty,
				rate: rate
			},
			api: {
				key: config.bittrex.api_key,
				secret: config.bittrex.api_secret
			}
		});
		// check for errors
		if (confirmation.success !== true) {
			throw new Error(confirmation.message);
		}
		return confirmation.result;
	},
	getOpenOrders: function* getOpenOrders() {
		const orders = yield makeRequest({
			url: `${marketUrl}/getopenorders`,
			params: {},
			api: {
				key: config.bittrex.api_key,
				secret: config.bittrex.api_secret
			}
		});
		// check for errors
		if (orders.success !== true) {
			throw new Error(orders.message);
		}
		return orders.result;
	},
	cancel: function* cancel(uuid) {
		const confirmation = yield makeRequest({
			url: `${marketUrl}/cancel`,
			params: {
				uuid: uuid
			},
			api: {
				key: config.bittrex.api_key,
				secret: config.bittrex.api_secret
			}
		});
		// check for errors
		if (confirmation.success !== true) {
			throw new Error(confirmation.message);
		}
		return confirmation.result;
	}
};

function* makeRequest(data) {
	// set up the options for the request
	const method = data.method ? data.method : "GET";
	if (!data.params) {
		data.params = {};
	}
	data.params["apikey"] = data.api.key;
	const nonce = new Date().getTime();
	data.params["nonce"] = nonce;
	const paramString = querystring.stringify(data.params);
	const uri = `${data.url}?${paramString}`;
	let headers = {
		"Content-Type": "application/json; charset=utf-8",
		// eslint-disable-next-line
		"apisign": crypto.HmacSHA512(uri, data.api.secret)
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
