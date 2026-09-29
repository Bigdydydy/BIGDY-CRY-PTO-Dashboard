# Lecture 12.16: Synthetic Positions

**Source URL**: https://insights.deribit.com/options-course/sections/section-12-strategies-and-combinations/options-course/lectures/lecture-12-16-synthetic-positions/

---

**It is often possible to create the same payoff as a particular financial instrument by combining two or more different financial instruments. **

In this lecture we will look at how to synthetically create a position in either the underlying, a call, or a put. To do so we will recreate each of those three instruments by using the other two instruments.

## Synthetic calls

For example, let's say we want to recreate the payoff of buying a particular call option without actually using the call option itself. One reason we may wish to do this for instance is if the liquidity for the call option we want to trade is currently poor.

![](https://insights.deribit.com/wp-content/uploads/2022/09/9248tfhwe9.jpg)

We can create the same payoff as the call option by buying a put option with the same strike price as the call, and longing the underlying. These two legs combined will create the same profit/loss as the call option no matter where the underlying price moves. By doing so we have recreated the call option synthetically. We have a position that will give the same profit outcome as the call option, but without using the call option itself.

![](https://insights.deribit.com/wp-content/uploads/2022/09/240ct8wje-1024x638.jpg)

If we wish to do the opposite and recreate a short call instead, we can simply reverse the two legs as well to create that position synthetically. So a short underlying position combined with a short put, will give us a position with the same payoff as a short call.

## Synthetic puts

Let's say we want to recreate the payoff of buying a particular put option without actually using the put option itself.

![](https://insights.deribit.com/wp-content/uploads/2022/09/94tv8weu.jpg)

We can create the same payoff as the put option by buying a call option with the same strike price as the put, and shorting the underlying. These two legs combined will create the same profit/loss as the put option no matter where the underlying price moves. This means we have recreated the put option synthetically. We have a position that will give the same profit outcome as the put option, but without using the put option itself.

![](https://insights.deribit.com/wp-content/uploads/2022/09/283r7cqh-1024x624.jpg)

As with the calls, if we wish to do the opposite and recreate a short put instead, we can simply reverse the two legs to create that position synthetically as well. So a long underlying position combined with a short call, will give us a position with the same payoff as a short put.

## Synthetic underlying

It’s not just options that we can create synthetically. We can use options to create a synthetic position in the underlying.

For example if we want to create a position with the same payoff as a long underlying position, but without using the underlying, we can do so using a put and a call.

![](https://insights.deribit.com/wp-content/uploads/2022/09/928ty8we-1024x714.jpg)

If we sell a put, and purchase a call with the same strike price, we create a payoff that is the same as being long the underlying.

![](https://insights.deribit.com/wp-content/uploads/2022/09/0239tcj0w9qe-1024x714.jpg)

If we want to create a position with the same payoff as a short underlying position instead, but without using the underlying, we can also do so using a put and a call, but we flip the direction of each leg of course.

![](https://insights.deribit.com/wp-content/uploads/2022/09/2948twy-1024x718.jpg)

If we buy a put, and sell a call with the same strike price, we create a payoff that is the same as being short the underlying.

![](https://insights.deribit.com/wp-content/uploads/2022/09/934t8we-1024x718.jpg)

We can summarise all of the combinations we have discussed in this table. As you can see, we can synthetically create any of these instruments, long or short, by using the correct combination of the other instruments.

![](https://insights.deribit.com/wp-content/uploads/2023/04/92c4teaifus.jpg)

Notes on reading this table:

Both the strike price and the expiration date of the call and put are the same.
Position sizes would need to be adjusted for contract sizes and option multipliers, for example stock options typically have a multiplier of 100 meaning each option represents 100 shares of stock.

## Summary

Synthetic positions can be useful when adjusting or hedging positions. They can allow traders to overcome liquidity issues, and sometimes even take advantage of any temporary price differences between an instrument and its synthetic equivalent.