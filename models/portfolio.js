const tradeConfig = require("../config/trading").config;

module.exports = {
	create: (id) => {
		return {
			_id: id,
			active: true,
			live: false,
			balance: tradeConfig.balance,
			positions: {},
			pending: {},
			blacklist: {}
		};
	}
};
