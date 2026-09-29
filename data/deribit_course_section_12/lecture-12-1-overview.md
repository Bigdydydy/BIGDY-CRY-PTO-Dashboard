# Lecture 12.1: Overview

**Source URL**: https://insights.deribit.com/options-course/sections/section-12-strategies-and-combinations/options-course/lectures/lecture-12-1-overview/

---

**Section 12 is a written section which introduces newer option traders to many of the most common and useful option trading strategies/combinations.**

We will spend a whole lesson looking at the theory side of each strategy, and then in section 13 we will show live examples of how to execute these strategies on the Deribit platform. Although section 12 can be read in its entirety, each lecture by itself should also serve as a useful stand-alone reference for traders who would like to check how a particular strategy is constructed. This will be of particular use for traders who need to know the differences between the linear contract version and the inverse contract version of each strategy.

In earlier sections we looked at single options, where we either bought or sold a single put or call option. All of the strategies we are about to explore in this section consist of at least 2 different legs in the same position. We will look at the profit and loss of the strategies, as well as how the Greeks behave as price changes, and as time passes.

When we start combining multiple options together, we can combine the Greeks for each leg to give us the Greek values for the whole strategy.

- The total delta will tell us how the value of the strategy as a whole will react to small changes in the underlying price.

- The total gamma will tell us how the delta of the strategy will react to small changes in the underlying price.

- The total vega will tell us how the value of the strategy will react to small changes in implied volatility.

- The total theta will tell us how the value of the strategy will change as time passes.

Many of the multi-leg option positions we will be discussing overlap with each other, and it is possible to express a particular view on the market in more than one way. It is often also possible to construct a strategy in more than one way by combining several other instruments, which may also include using futures.

## No free lunch

It’s worth mentioning that none of the strategies we will be discussing in this section have an inherent edge. There is no ‘magic’ combination of options that will always make a profit in every market or at all times. Any edge will come from studying the market, having a view on where there may be some value, and then knowing what structures will help you express your view and extract that value.

This course aims to give you a solid foundation of knowledge about how options work, both individually and in combination with each other. This includes how options react to changes in certain parameters like time and volatility. However we intentionally stop short of offering any specific trading advice.

Even though we will now detail what are known as ‘strategies’, in reality they are merely different combinations of options that when executed together, are given certain names. These names allow us to quickly reference and discuss multi-leg option positions more easily, but they do not by themselves represent any kind of strategic advantage or positive expected value unless executed at the right time.

Having said that, let’s begin defining some multi-leg option strategies.