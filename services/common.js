const querystring = require("querystring");
const rp = require("request-promise");
const winston = require("winston");
winston.cli();
winston.level = "verbose";

module.exports = {
	db: {
		"portfolios": "coin-signals_portfolios",
		"trades": "coin-signals_trades"
	},
	log: (level, msg) => {
		winston.log(level, msg);
	},
	makeRequest: function* makeRequest(data) {
		// set up the options for the request
		const method = data.method ? data.method : "GET";
		if (!data.params) {
			data.params = {};
		}
		const paramString = querystring.stringify(data.params);
		const uri = `${data.url}?${paramString}`;
		let headers = {
			"Content-Type": "application/json; charset=utf-8"
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
	},
	bitRound: (price) => {
		return parseFloat(price).toFixed(8);
	},
	percent: (price) => {
		return (Math.floor(price * 100000) / 1000).toFixed(3);
	},
	getRandomArbitrary: (min, max) => {
		return Math.random() * (max - min) + min;
	},
	formatTicker: (position, price) => {
		const percChange = Math.round(((price - position.price) / position.price) * 10000) / 100;
		return `[${position.pair} / ${module.exports.bitRound(price)} BTC / ${percChange > 0 ? "+" : ""}${percChange}%]`;
	}
};
