# :money_with_wings: Coin Signals Trader
The Coin Signals trader is meant to allow anyone to quickly and easily set up an automated trading bot.  This bot relies on __Signals__ which are supplied via Slack in the __Universal Signal Format__.  This project doesn't generate it's own signals, it only acts on ones that it receives.

## Donate
This is a free project, so if you're like to thank me for my work, I'd really appreciate that.

- BTC - __1E6Vyh84pTEP9v6Sh8Yzm693pBZLvguX3m__
- ETH - __0xb2921b476838c8DB9a29d708B3cA8c11959D7c7D__
- LTC - __LfkD8jcgv4E2rDta4hA2CUHNMiPGdZL1yr__

## Prerequisites
* [Node.js](https://nodejs.org/en/) (Version 6 and up recommended)
* [Bittrex API Key](https://bittrex.com/Manage#sectionApi)
* [Slack](https://slack.com)

### Installation

* Clone down the repository.
```
git clone https://github.com/snollygolly/coin-signals-trader.git
```

* Install packages (from inside the coin-signals-trader folder).
```
npm install
```

* Create your config.  There's a `config.json.example` file in the root.  Edit it to include all your values.  Refer to the configuration breakdown for more information about what does what.  Save it as `config.json` and leave it in the root.

* Run the bot!
```
npm start
```

* Private message the bot in slack to get started

## Universal Signal Format
Signals are sent via Slack and are expected to be in the correct format:

```
^ACTION*PAIR*QUANTITY*PRICE*META^
```

- Action _(Required)_
This is the action you want the trader to take
  - BUY
  - SELL

- Pair _(Required)_
This is pair you want to trade _(like BTC-LTC)_

- Quantity
This is how many coins you want to affect in this signal.  If you'd like the trader bot to use it's defaults, you can pass "A"

- Price
This is the per coin price you want to use for this signal.  If you'd like the trader bot to use it's default, you can pass "A"

- Meta
If you'd like to attach addition information to your signal, you may do it here.  The symbol * may not be used in meta information though.

### Example

```
BUY*BTC-LTC*1*0.01*0001
```

This signal would buy 1 Litecoin (BTC-LTC) for 0.01 BTC.  It would also includes some meta information (0001).

```
SELL*BTC-LTC*A*A*0002
```

This signal would sell the default amount of Litecoins at the default price.  It also includes meta information (0002)

### Folder Structure (some files omitted)

```
|-- coin-signals
    |-- config
    (contains all the settings for customizing the bot's behavior)
    |-- services
    |-- config.json
    (contains all configuration values, more on that later, it must be created)
    |-- seed.js
    (creates all the needed files [will overwrite your portfolio])
    |-- index.js
    (this is what you run to actually start auto-trading)
```

### Configuration breakdown

The configuration file for the `bot` project is fairly simple and consists mainly of settings for Slack and Bittrex:

```
{
  "name": "Coin Signals Trader",
  "bittrex": {
    "api_key": "XXX",
    "api_secret": "XXX"
  },
  "slack": {
    "url": "XXX",
    [the webhook url]
    "name": "Coin Trader",
    [the name of the bot]
    "secret": "XXX",
    [from your slack app]
    "channel": "signals",
    [what channel in slack to join]
    "bot": "XXX",
    [the id of the bot who's signals you are consuming]
    "admin": "XXX"
    [the id of the user who can execute commands]
  },
  "trading": {
    "api_key": "XXX",
    [your bittrex key for trading]
    "api_secret": "XXX"
    [your bittrex secret for trading]
  }
}
```

### Trading configuration

This configuration lives in `config/trading.js`

```
live: false,
[real money or not]
balance: 0.125,
fee: 0.0025,
[how much is the fee each way]
limits: {
  fresh: {
    loss: 0.08,
    [what amount of loss you will accept at this stage]
    profit: 0.05,
    [what amount of profit you will target at this stage]
    time: 1800000
    [how much time (in ms) needs to elapse before this position isn considered fresh]
  },
  stale: {
    loss: 0.06,
    [what amount of loss you will accept at this stage]
    profit: 0.03,
    [what amount of profit you will target at this stage]
    time: 3600000
    [how much time (in ms) needs to elapse before this position is considered stale]
  },
  old: {
    loss: 0.05,
    [what amount of loss you will accept at this stage]
    profit: 0.02,
    [what amount of profit you will target at this stage]
    time: 7200000
    [how much time (in ms) needs to elapse before this position is considered old]
  }
},
order_parsing: false,
[do we want orderbook parsing enabled or not]
orders: {
  spread_ask: 0.01,
  [what percentage should the "ask" spread be below for a sell signal to be generated]
  spread_ask_insta: 0.001,
  [what percentage should the "ask" spread be below to instantly sell]
  spread_avg: 0.015,
  [what percentage should the "avg" spread be above for a sell signal to be generated]
  spread_avg_insta: 0.03
  [what percentage should the "avg" spread be above to instantly sell]
},
profit_increase: 0.001,
[when we attempt to lock in profit, how much should our target be above the current price (in percentage)]
profit_slip: 0.001,
[when we attempt to lock in profit, how much should our target be below the current price (in percentage)]
profit_increase_override: 0.01,
[when the profit increases this percent or may over a single tick, sell regardless]
initial_sell_delay: 300000,
[prevents sells if they happen before this many ms has passed]
spread_to_sell: 0.00000001,
[what spread amount (in BTC) to auto sell at]
min_balance: 0.00001,
[minimum balance]
max_position_price: 0.0115,
[maximum price per position]
max_points: 95,
[this many points gets the max position price, lower signals get less of the max position price]
max_positions: 10,
[maximum positions at a time]
max_volitility: -0.02,
[how much volitility to accept from USD/BTC before trading halts]
volitility_timeout: 45 * 60 * 1000,
[how long to halt trading for]
toxic_asset_backoff: 180000
[how long (in ms) to blacklist losing assets for (per point lost)]
```
