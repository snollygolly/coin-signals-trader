const config = require("./config.json");
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
let signal = null;

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

adminMessageHandler = (data) => {
	const commandExp = /!(\w+) ?(\w+-\w+)? ?(A|\d?\.?\d+)?/i;
	const matches = commandExp.exec(data.text);
	const commands = {
		buy: () => { },
		sell: () => {
			if (!matches[3]) {
				common.log("warn", "! Not enough parameters");
				return;
			}
			return liquidate(matches[2], matches[3]); },
		writeoff: () => {
			if (!matches[2]) {
				common.log("warn", "! Not enough parameters");
				return;
			}
			return writeoff(matches[2]); },
		halt: () => { return halt(); },
		resume: () => { return resume(); },
		exit: () => {
			exiting = !exiting;
			common.log("info", `+ ${exiting === true ? "No new" : "Accepting all"} orders`);
			return exitPositions();
		},
		ping: () => { common.log("info", "! Pong"); }
	};
	if (!matches[1] || !commands[matches[1]]) {
		common.log("error", "! Bad command");
		return;
	}
	return commands[matches[1]]();
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
				yield bot.postMessage(config.slack.admin.channel, result, params);
			}
		}
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

function liquidate(position, price) {
	co(function* co() {
		const result = yield trading.liquidate(position, price);
		yield bot.postMessage(config.slack.admin.channel, result, params);
	}).catch((err) => {
		common.log("error", "! Error during liquidation");
		blocked = false;
		throw new Error(err.stack);
	});
};

function writeoff(position) {
	co(function* co() {
		const result = yield trading.writeoff(position);
		yield bot.postMessage(config.slack.admin.channel, result, params);
	}).catch((err) => {
		common.log("error", "! Error during writeoff");
		blocked = false;
		throw new Error(err.stack);
	});
};


function halt() {
	co(function* co() {
		const result = yield trading.halt();
		yield bot.postMessage(config.slack.admin.channel, "Halted trading, monitoring only", params);
	}).catch((err) => {
		common.log("error", "! Error during halting");
		blocked = false;
		throw new Error(err.stack);
	});
};

function exitPositions() {
	co(function* co() {
		yield bot.postMessage(config.slack.admin.channel, `${exiting === true ? "No new" : "Accepting all"} orders`, params);
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
			yield bot.postMessage(config.slack.admin.channel, "Resuming trading", params);
		}
	}).catch((err) => {
		common.log("error", "! Error during resume");
		blocked = false;
		throw new Error(err.stack);
	});
};

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
