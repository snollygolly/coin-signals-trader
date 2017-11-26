const tradeConfig = require("../config/trading").config;

module.exports = {
	name: "portfolio",
	create: (id) => {
		return {
			_id: id,
			active: true,
			live: tradeConfig.live,
			balance: tradeConfig.balance,
			positions: {},
			pending: {},
			blacklist: {}
		};
	}
};
