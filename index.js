const config = require("./config.json");
const common = require("./services/common");
const db = require("./services/db");
const bittrex = require("./services/bittrex");
const trading = require("./services/trading");

const co = require("co");
const SlackBot = require("slackbots");

const data = {
	market: null
};

let started = false;
let blocked = false;
let exiting = false;
let signal = null;

common.log("info", `* Connecting to Slack as ${config.slack.name}`);

// create a bot
const bot = new SlackBot({
	token: config.slack.secret,
	name: config.slack.name
});

bot.on("start", () => {
	common.log("info", "* Connected!");
	bot.postMessage(config.slack.channel, "I've joined!").then((data) => {
		// everything was successful, let's start the bot
		// TODO: check to make sure we have enough money
		common.log("info", `+ Joined ${config.slack.channel}`);
		started = true;
		// starting update loop
		updatePositions();
		positionLoop = setInterval(updatePositions, 10000);
	}).fail((data) => {
		common.log("warn", `! You don't have access to ${config.slack.channel}`);
		return;
	});
});

bot.on("message", (data) => {
	if (started === false) {
		common.log("warn", "! Events can't be parsed because the bot hasn't been started");
		return;
	}
	if (data.text === "ping") {
		common.log("info", "! Pong");
		return;
	}
	// handle admin stuff
	if (data.user === config.slack.admin && data.type === "message") {
		if (data.text === "ping") {
			common.log("info", "! Pong");
			return;
		}
		if (data.text.indexOf("HALT") !== -1) {
			return halt();
		}
		if (data.text.indexOf("RESUME") !== -1) {
			return resume();
		}
		if (data.text.indexOf("EXIT") !== -1) {
			exiting = !exiting;
			common.log("info", `+ ${exiting === true ? "No new" : "Accepting all"} orders`);
			return exitPositions();
		}
		if (data.text.indexOf("SELL") !== -1) {
			// manual liquidation
			const sellParts = data.text.split(" ");
			if (sellParts.length !== 3) {
				common.log("warn", "! Malformed liquidation attempt");
				return;
			}
			return liquidate(sellParts[1], sellParts[2]);
		}
		if (data.text.indexOf("WRITEOFF") !== -1) {
			// manual liquidation
			const sellParts = data.text.split(" ");
			if (sellParts.length !== 2) {
				common.log("warn", "! Malformed writeoff attempt");
				return;
			}
			return writeoff(sellParts[1]);
		}
		return;
	}
	if (!data.bot_id) {
		// common.log("verbose", "! No bot ID");
		return;
	}
	if (data.bot_id !== config.slack.bot) {
		// common.log("verbose", "! Bad bot ID");
		return;
	}
	if (exiting === true) {
		return;
	}
	createSignal(data);
});

function createSignal(data) {
	const signals = trading.parseSignals(data);
	// TODO: consider handling multiple signals from a batch
	signal = signals.shift();
};

function updatePositions() {
	if (blocked === true) {
		common.log("error", "! Updates can't be performed because we are blocked");
		return;
	}
	blocked = true;
	co(function* co() {
		if (signal !== null) {
			const result = yield trading.buySignal(signal);
			signal = null;
			if (result !== false) {
				yield bot.postMessage(config.slack.channel, result);
			}
		}
		const marketData = yield trading.updateData();
		result = yield trading.updatePositions({
			marketDoc: marketData
		});
		blocked = false;
		if (result !== false) {
			for (const item of result) {
				yield bot.postMessage(config.slack.channel, item);
			}
		}
	}).catch((err) => {
		common.log("error", "! Error during update position");
		blocked = false;
		throw new Error(err.stack);
	});
}

function liquidate(position, price) {
	co(function* co() {
		const result = yield trading.liquidate(position, price);
		yield bot.postMessage(config.slack.channel, result);
	}).catch((err) => {
		common.log("error", "! Error during liquidation");
		blocked = false;
		throw new Error(err.stack);
	});
};

function writeoff(position) {
	co(function* co() {
		const result = yield trading.writeoff(position);
		yield bot.postMessage(config.slack.channel, result);
	}).catch((err) => {
		common.log("error", "! Error during writeoff");
		blocked = false;
		throw new Error(err.stack);
	});
};


function halt() {
	co(function* co() {
		const result = yield trading.halt();
		yield bot.postMessage(config.slack.channel, "Halted trading, monitoring only");
	}).catch((err) => {
		common.log("error", "! Error during halting");
		blocked = false;
		throw new Error(err.stack);
	});
};

function exitPositions() {
	co(function* co() {
		yield bot.postMessage(config.slack.channel, `${exiting === true ? "No new" : "Accepting all"} orders`);
	}).catch((err) => {
		common.log("error", "! Error during exit positions");
		blocked = false;
		throw new Error(err.stack);
	});
};


function resume() {
	co(function* co() {
		const result = yield trading.resume();
		if (result !== false) {
			yield bot.postMessage(config.slack.channel, "Resuming trading");
		}
	}).catch((err) => {
		common.log("error", "! Error during resume");
		blocked = false;
		throw new Error(err.stack);
	});
};
