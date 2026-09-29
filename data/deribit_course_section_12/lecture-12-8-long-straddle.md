# Lecture 12.8: Long Straddle

**Source URL**: https://insights.deribit.com/options-course/sections/section-12-strategies-and-combinations/options-course/lectures/lecture-12-8-long-straddle/

---

**A long straddle is a strategy that involves buying both a put and call that share the same strike price and expiration date. As we are buying options, we want volatility to increase and the underlying price to move as much as possible. However, because we are buying both a put option and a call option with the same strike price, we are agnostic about which direction the underlying price moves, at least initially.**

A long straddle is a price neutral strategy, and will typically have a delta close to zero when it is opened. The strategy is also bullish on volatility. So, we don’t much care which direction the underlying price moves, as long as it moves a lot. The strategy is constructed by:
-Purchasing a call option with strike price A
-Purchasing a put option with strike price A

Both options have the same expiry date, and the underlying price is typically somewhere close to the strike price A.

Both options are purchased and therefore a net debit is paid to open the long straddle. This gives us a payoff chart that looks like this.

![](https://insights.deribit.com/wp-content/uploads/2022/09/924ctuhcwfe-1024x686.jpg)

The risk is capped at the premium paid, and the maximum loss will only occur if the underlying price is precisely at the strike price at expiry.

The maximum profit is uncapped in both directions (other than by the underlying price reaching zero of course), and in dollar terms the payoff is symmetrical either side of the strike price. This very attractive looking payoff does not come without cost though, as we have had to purchase both the put and the call, meaning a much larger net debit has been paid than if we had chosen a direction by only purchasing one of the options.

If we hold the long straddle until expiry with no further adjustments, it is simply a bet that the underlying price will have moved outside of a certain range. This range is determined by our two breakeven points. In dollar terms, the breakeven points can be calculated as:
First Breakeven = Strike price – Premium
Second Breakeven = Strike price + Premium

## The Greeks

We can add our Greek values for the put at strike A to the values for the call at strike A, and this will give us the total Greek values for the long straddle.

To analyse how the Greeks behave we will use the following figures:

Underlying price: $100
Time to expiry: 50 days
Interest rate: 0
Implied volatility: 60%
Strike A: $100

## Profit and loss

With these parameters the $100 straddle will initially cost us about $17.68. The payoff chart looks like this.

![](https://insights.deribit.com/wp-content/uploads/2022/09/2947cw-1024x568.jpg)

The maximum loss is capped at the premium paid, which is $17.68. The maximum loss occurs when the underlying price is precisely at the strike price of $100 at expiry.

To the downside, the maximum profit is only capped if the underlying price reaches zero, and the maximum profit is completely uncapped to the upside. The further the price moves in either direction the more money we make at expiry.

There are two breakeven prices, one to the upside and one to the downside. The one to the downside is calculated by subtracting the total premium paid from the strike price, which gives us:

$100 – $17.68 = $82.32

The breakeven price to the upside is calculated by adding the total premium paid to the strike price, which gives us:

$100 + $17.68 = $117.68

## Delta

The long straddle is the first strategy that we have looked at that can have either a positive or negative delta. The sign of the delta depends on where the underlying price is relative to the strike price.

This chart shows the delta of the long straddle, with the x axis being the underlying price. The extra lines also show how the delta will evolve as time passes.

![](https://insights.deribit.com/wp-content/uploads/2022/09/aow84tncy-1024x568.jpg)

When the underlying price is close to the strike price, the positive delta gained from the call and the negative delta gained from the put largely cancel each other out. The total delta for the long straddle is therefore very small when the underlying price is close to the strike price.

When the underlying price decreases, the negative delta from the put option increases in magnitude, whereas the positive delta from the call decreases in magnitude. Both of these have the effect of making our total delta increasingly negative as the underlying price decreases. The more the underlying price decreases, the more negative our delta becomes, meaning we effectively get more short the underlying as the price decreases. Eventually the delta of the deep OTM call approaches 0, while the delta of the deep ITM put approaches -1. This means our total delta approaches -1 as the underlying price continues to decrease.

Conversely, when the underlying price increases, the negative delta from the put decreases in magnitude, whereas the positive delta from the call increases in magnitude. Both of these have the effect of making our total delta increasingly positive as the underlying price increases. The more the underlying price increases, the more positive our delta becomes, meaning we effectively get more long the underlying as the price increases. Eventually the delta of the deep OTM put approaches 0, while the delta of the deep ITM call approaches 1. This means our total delta approaches 1 as the underlying price continues to increase.

So by being long a straddle, we are effectively speculating that the market will trend. The more the market does trend, the more the long straddle will make.

As time passes the price range where delta is anything other than 1 or -1 gets narrower, and the delta delta line gets much steeper, meaning delta changes much faster within this smaller range.

## Gamma

As we move from left to right on the delta chart, the delta of the long straddle is always increasing. This means the gamma is always positive.

![](https://insights.deribit.com/wp-content/uploads/2022/09/94t8wynef-1024x568.jpg)

The steeper the delta line, the more extreme the gamma is. The delta line is steepest when we are relatively close to the strike price, so this is where gamma peaks.

When we get much closer to expiry, the price range where there is any significant delta is much narrower, and delta changes much quicker. On the gamma chart this results in a narrower price range for significant gamma, and much more extreme values of gamma due to the more rapid changes in delta. The less time until the options expire, the closer the peak in gamma will be to the strike price.

## Vega

We are long both a put and a call. Both of these options have positive vega, so our total vega for the long straddle is always positive, and always greater than for either of the two individual options.

![](https://insights.deribit.com/wp-content/uploads/2022/09/23r08qnehf-1024x568.jpg)

As you may remember from section 10, the buyer of any option has a positive vega. The magnitude of this vega is greatest when the option is close to the money, and as time passes, the magnitude decreases no matter where the underlying price is in relation to the strike price.

The long straddle clearly benefits from an increase in implied volatility, and suffers from a decrease in implied volatility. If all else remains equal and implied volatility increases, both the put and the call will increase in value, resulting in a double gain for our long straddle.

## Theta

So far the long straddle is looking quite attractive. Theta though, is the major downside to a long straddle. All long options have negative theta, meaning they lose value as time passes. With a long straddle we are long a put and a call, both of which will lose value as time passes. It’s also only possible for one of them to be ITM at expiry so at least one of them is guaranteed to lose all of its value by expiry.

![](https://insights.deribit.com/wp-content/uploads/2022/09/20tvwje-1024x568.jpg)

The magnitude of the theta is greatest when the underlying price is close to the strike price. This is where the options will have the most extrinsic value, and therefore the most value to lose to time decay. When we initially open the long straddle we will typically be using ATM options, so they are likely to have plenty of extrinsic value to lose as time passes.

As time passes, the price range where there is any significant theta gets smaller, and the peak theta is of a greater magnitude.

A straddle results in a battle between time (the theta) and underlying price movement. Underlying price movement in either direction benefits our long straddle. However, this movement must happen fast enough for us to get the full benefit. When we hold the long straddle until expiry, if the underlying price has failed to move far enough away from the strike price, we will fail to make a profit, no matter how volatile the price movements have been over the life of the trade.

If our aim is to speculate on volatility rather than how far price has moved at expiry, it is possible to continuously adjust the long straddle such that whether we make a profit or not is much less reliant on the final underlying price, and is instead more reliant on volatility. If we continue to hedge the delta of the straddle as the trade progresses, our profit is then much more reliant on the realised volatility over the lifetime of the trade compared to the level of implied volatility that we initially paid for the options. Though the result does then depend on the path the underlying price takes. You may wish to research path dependency for more information on this topic.

It is of course possible to delta hedge any option position. However, a straddle is the first strategy that we have covered that is likely to be executed purely as a speculation on volatility, so it’s worth mentioning in this lecture specifically, even if only briefly.

Delta hedging the straddle involves buying and selling some of the underlying (or futures on the underlying) to keep our delta close to zero for the whole trade. Delta hedging could be several lectures in itself, so we will leave more details on this subject for another time. We will cover a live trading example of a long straddle with delta hedging in section 13.

## Inverse option contracts

A long straddle consists of a long put and a long call. The same is true when using the inverse option contracts on Deribit.

This chart shows the bitcoin payoff at expiry of a long straddle using the bitcoin options on Deribit. In this example we’ve purchased one call option with a strike price of $50,000, and purchased one put option also with a strike price of $50,000. We pay 0.05 BTC for each option, and therefore pay a total of 0.1 BTC for the long straddle.

![](https://insights.deribit.com/wp-content/uploads/2022/09/29tvhw9f-1024x685.jpg)

The shape of the profit/loss in bitcoin terms is relatively similar to the profit/loss in dollar terms that we saw earlier. Due to the nature of payoffs with inverse contracts, the line is curved instead of straight, and we can also see that if the underlying price decreases, we make far more bitcoin than for an equivalent increase in price. This is due to how much bitcoin it takes to pay a fixed amount of dollars when the underlying price is different.

For example, if the underlying price is $10,000 lower than our strike price at expiry, and is therefore at $40,000, our $50,000 put is worth $10,000. As the underlying price is now $40,000, $10,000 is the equivalent of 0.25 BTC. We paid 0.1 BTC for the straddle, so our profit is 0.15 BTC.

If instead the underlying price is $10,000 higher than our strike price at expiry, and is therefore at $60,000, our $50,000 call is worth $10,000. As the underlying price is now at $60,000, $10,000 is the equivalent of about 0.1667 BTC. We paid 0.1 BTC for the straddle, so our profit is roughly 0.0667 BTC.

Notice here that the dollar value of the straddle is exactly the same in both cases, but we receive a very different amount of bitcoin for it. This is due to the difference in the underlying bitcoin price at expiry. The dollar profit/loss chart is still perfectly symmetrical, but the bitcoin profit/loss chart is not.

If desired, it is possible to increase the bitcoin profit on the call side by buying more of the calls than the puts, though this will increase the total premium paid of course. No matter what the chosen ratio of puts to calls though, the bitcoin profit/loss chart for a long straddle will never be perfectly symmetrical.

## When are long straddles attractive?

A long straddle involves purchasing a put and a call, both of which are usually ATM and therefore have the most extrinsic value. Due to this, a long straddle can be an expensive strategy to open. The theta is high so it loses a lot of value as time passes. In order to be profitable, this needs to be made up for by high volatility in the underlying price.

It follows then that long straddles will be most attractive when implied volatility is lower than we are expecting future volatility to be. We could for example have this opinion because the recent realised volatility is higher than the current implied volatility. Or perhaps because implied volatility is currently at historical lows and we expect it to revert to the mean by increasing soon.

The point here is not to give a defined system for when to trade straddles, but to point out that no matter what the system, the price paid for the straddle is important. It is not enough to simply say that we expect the underlying to move a lot so we are going to buy a straddle regardless of the cost. The chosen straddle needs to be priced attractively compared to our expectation for the underlying price over the lifetime of the options. If we are planning to hold the straddle until expiry, we could simply calculate the breakeven points given the current price of the straddle, and compare that to our expectations of how far the underlying price is likely to move. If we are planning to delta hedge the straddle, we can compare the implied volatility of the straddle with our forecast for volatility.

The price of any option strategy, not just straddles, should factor into your judgement of whether it is attractive or not.