const config = require("./config.json");
const tradeConfig = require("./config/trading").config;
const common = require("./services/common");
const db = require("./services/db");
const bittrex = require("./services/bittrex");
const trading = require("./services/trading");

const Promise = require("bluebird");
const fs = Promise.promisifyAll(require("fs"));
const co = require("co");
const SlackBot = require("slackbots");

const data = {
	market: null
};

let started = false;
let blocked = false;
let exiting = false;

common.log("info", `* Connecting to Slack as ${config.slack.name}`);

// create a bot
const bot = new SlackBot({
	token: config.slack.secret,
	name: config.slack.name
});

const params = {
	icon_emoji: ":money_with_wings:"
};

bot.on("start", () => {
	common.log("info", "* Connected!");
	// check to see if this is the first time running
	if (!config.slack.admin) {
		common.log("verbose", "+ Starting in setup mode");
		return;
	}

	bot.postMessage(config.slack.admin.channel, "I've joined!", params).then((data) => {
		// everything was successful, let's start the bot
		// TODO: check to make sure we have enough money
		common.log("info", `+ Joined #${config.slack.admin.channel}`);
		started = true;
		// starting update loop
		updatePositions();
		positionLoop = setInterval(updatePositions, 10000);
	}).fail((data) => {
		common.log("warn", `! You don't have access to ${config.slack.admin.channel}`);
		return;
	});
});

adminMessageHandler = (data) => {
	const commandExp = /!(\w+) ?(\w+-\w+)? ?(A|\d?\.?\d+)? ?(A|\d?\.?\d+)?/i;
	const matches = commandExp.exec(data.text);
	const commands = {
		buy: function* buy() {
			if (!matches[3]) {
				common.log("warn", "! Not enough parameters");
				return;
			}
			const result = yield trading.purchase(matches[2], matches[3], matches[4]);
			yield bot.postMessage(config.slack.admin.channel, result, params);
		},
		sell: function* sell() {
			if (!matches[3]) {
				common.log("warn", "! Not enough parameters");
				return;
			}
			const result = yield trading.liquidate(matches[2], matches[3]);
			yield bot.postMessage(config.slack.admin.channel, result, params);
		},
		writeoff: function* writeoff() {
			if (!matches[2]) {
				common.log("warn", "! Not enough parameters");
				return;
			}
			const result = yield trading.writeoff(matches[2]);
			yield bot.postMessage(config.slack.admin.channel, result, params);
		},
		halt: function* halt() {
			const result = yield trading.halt();
			yield bot.postMessage(config.slack.admin.channel, "Halted trading, monitoring only", params);
		 },
		resume: function*  resume() {
			const result = yield trading.resume();
			if (result !== false) {
				yield bot.postMessage(config.slack.admin.channel, "Resuming trading", params);
			}
		},
		exit: function* exit() {
			exiting = !exiting;
			const result = `${exiting === true ? "No new" : "Accepting all"} orders`;
			common.log("info", `+ ${result}`);
			yield bot.postMessage(config.slack.admin.channel, result, params);
		},
		ping: function* ping() {
			// remove me
			common.log("info", "! Pong");
			yield bot.postMessage(config.slack.admin.channel, "Pong", params);
		},
		portfolio: function* portfolio() {
			let trades = yield db.runView(new RegExp(/-sell/g), common.db.trades);
			const portfolio = yield db.getDocument("portfolio", common.db.portfolios);
			const stats = {
				totalProfit: 0,
				totalProfitPerc: 0,
				trades: 0
			};
			for (const trade of trades) {
				stats.totalProfit += parseFloat(trade.profit.amount);
				stats.trades++;
			}
			trades = trades.sort((a, b) => {
				return parseInt(b.created) - parseInt(a.created);
			});
			stats.totalProfitPerc = `${common.percent(stats.totalProfit / tradeConfig.balance)}%`;
			const message = `
				You've sold ${stats.trades} positions so far and you still have ${Object.keys(portfolio.positions).length} more open.\nYou've made ${stats.totalProfit} BTC in total profit for a return of ${stats.totalProfitPerc}.
			`;
			yield bot.postMessage(config.slack.admin.channel, message, params);
		}
	};
	if (!matches || !matches[1] || !commands[matches[1]]) {
		common.log("error", "! Bad command");
		return;
	}
	// actually take action on the message
	co(function* co() {
		yield commands[matches[1]]();
	}).catch((err) => {
		common.log("error", "! Error during admin command");
		blocked = false;
		throw new Error(err.stack);
	});
};

const signalMessageHandler = (data) => {
	if (data.type !== "message") { return; }
	if (started === false) {
		common.log("warn", "! Events can't be parsed because the bot hasn't been started");
		return;
	}
	// handle admin stuff
	if (data.user === config.slack.admin.user && data.channel === config.slack.admin.channel) {
		return adminMessageHandler(data);
	}
	// handle signal stuff
	if (data.channel !== config.slack.channel.id) { return; }
	if (config.slack.channel.bot !== "debug") {
		if (!data.bot_id) { return; }
		if (data.bot_id !== config.slack.channel.bot) { return; }
	}
	if (exiting === true) { return; }
	createSignal(data);
};

let messageHandler;

if (!config.slack.admin) {
	messageHandler = handleSetup;
} else {
	messageHandler = signalMessageHandler;
}

bot.on("message", messageHandler);

function createSignal(data) {
	const signals = trading.parseSignals(data);
	const signal = signals.shift();
	if (blocked === true) {
		common.log("error", "! Updates can't be performed because we are blocked");
		return;
	}
	blocked = true;
	co(function* co() {
		let result;
		if (signal.action === "BUY") {
			result = yield trading.buySignal(signal);
		} else if (signal.action === "SELL") {
			result = yield trading.liquidate(signal.pair, signal.price);
		}
		blocked = false;
		if (result === false) {
			// something went wrong
			return;
		}
		yield bot.postMessage(config.slack.admin.channel, result, params);
	}).catch((err) => {
		common.log("error", "! Error during signal creation");
		blocked = false;
		throw new Error(err.stack);
	});
};

function updatePositions() {
	if (blocked === true) {
		common.log("error", "! Updates can't be performed because we are blocked");
		return;
	}
	blocked = true;
	co(function* co() {
		const marketData = yield trading.updateData();
		result = yield trading.updatePositions({
			marketDoc: marketData
		});
		blocked = false;
		if (result !== false) {
			for (const item of result) {
				yield bot.postMessage(config.slack.admin.channel, item, params);
			}
		}
	}).catch((err) => {
		common.log("error", "! Error during update position");
		blocked = false;
		throw new Error(err.stack);
	});
}

function handleSetup(data) {
	if (!data.text || data.subtype === "bot_message") { return; }
	co(function* co() {
		// check for the password
		if (data.text.indexOf(config.slack.password) !== -1) {
			// they entered the password
			config.slack.admin = {
				user: data.user,
				channel: data.channel
			};
			yield fs.writeFileAsync(`${__dirname}/config.json`, JSON.stringify(config, null, 2));
			yield bot.postMessage(config.slack.admin.channel, "You've been authenticated!  You must restart the bot now.", params);
			process.exit();
		}
		yield bot.postMessage(data.channel, "Please authenticate by sending me the password you chose in the config.json file.", params);
	}).catch((err) => {
		common.log("error", "! Error during authentication");
		blocked = false;
		throw new Error(err.stack);
	});
};
