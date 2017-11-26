module.exports.config = {
	live: false,
	balance: 0.25,
	fee: 0.0025,
	limits: {
		fresh: {
			loss: 0.07,
			profit: 0.04,
			time: 1800000
		},
		stale: {
			loss: 0.06,
			profit: 0.03,
			time: 3600000
		},
		old: {
			loss: 0.05,
			profit: 0.02,
			time: 7200000
		}
	},
	order_parsing: true,
	orders: {
		spread_ask: 0.01,
		spread_ask_insta: 0.001,
		spread_avg: 0.015,
		spread_avg_insta: 0.03
	},
	profit_increase: 0.005,
	profit_slip: 0.005,
	profit_increase_override: 0.05,
	initial_sell_delay: 600000,
	spread_to_sell: 0.00000001,
	min_balance: 0.00001,
	max_position_price: 0.022,
	max_points: 95,
	max_positions: 10,
	max_volitility: 0.0075,
	volitility_timeout: 45 * 60 * 1000,
	toxic_asset_backoff: 100000
};
