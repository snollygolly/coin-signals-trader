const config = require("./config.json");

const co = require("co");
const common = require("./services/common");
const db = require("./services/db");
const portfolioModel = require("./models/portfolio");
const tradeConfig = require("./config/trading").config;

const manifest = {
	databases: [
		common.db.portfolios,
		common.db.trades
	],
	views:  {
		[common.db.trades]: {
			all: {
				map: function(doc) { emit(doc._id.split("x").shift(), null); }
			},
			sold: {
				map: function(doc) { if (doc.profit.amount) { emit(doc._id.split("x").shift(), null); } }
			}
		},
		[common.db.users]: {
			all_enabled: {
				map: function(doc) { if (doc.enabled === true) { emit(doc._id, doc.priority); } }
			}
		}

	}
};

co(function* co() {
	// create the databases
	common.log("info", ".:. Creating Databases .:.");
	for (const db of manifest.databases) {
		// run the create method
		yield createDatabase(db);
	}

	common.log("info", ".:. Creating Views .:.");
	for (const key in manifest.views) {
		// creates the view
		yield createView(key);
	}

	common.log("info", ".:. Seeding Trading Portfolio .:.");
	try {
		const portfolio = portfolioModel.create("portfolio");
		yield db.saveDocument(portfolio, common.db.portfolios);
		common.log("info", "* Document 'portfolio' created!");
	} catch (err) {
		common.log("warn", "! Seeding 'portfolio' failed");
	}
	common.log("info", ".:. Seeding Complete! .:.");
}).catch((err) => {
	throw new Error(err.stack);
});

// FUNCTIONS TO ACTUALLY DO THE STUFF HERE

function* createDatabase(name) {
	const confirmation = yield db.createDatabase(name);
	if (confirmation.error === true) {
		common.log("warn", `! Database '${name}' creation failed!`);
	} else {
		common.log("info", `* Database '${name}' created!`);
	}
	return confirmation;
}

function* createView(name) {
	const result = yield db.saveView("listing", manifest.views[name], `${name}`);
	if (result.error === true) {
		common.log("warn", `! View '${name}' creation failed!`);
	} else {
		common.log("info", `* View '${name}' created!`);
	}
}
