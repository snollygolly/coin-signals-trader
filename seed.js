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
	]
};

co(function* co() {
	// create the databases
	common.log("info", ".:. Creating Databases .:.");
	for (const db of manifest.databases) {
		// run the create method
		yield createDatabase(db);
	}

	common.log("info", ".:. Seeding Trading Portfolio .:.");
	try {
		yield db.removeDocument(portfolioModel.name, common.db.portfolios);
		common.log("info", `* Document '${portfolioModel.name}' deleted!`);
	} catch (err) {
		throw new Error(err.stack);
		common.log("warn", `* Deleting '${portfolioModel.name}' failed!`);
	}

	try {
		const portfolio = portfolioModel.create(portfolioModel.name);
		yield db.saveDocument(portfolio, common.db.portfolios);
		common.log("info", `* Document '${portfolioModel.name}' created!`);
	} catch (err) {
		common.log("warn", `* Saving '${portfolioModel.name}' failed!`);
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
