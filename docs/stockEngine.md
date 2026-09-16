## What is a GBM model?
A **geometric Brownian motion** (**GBM**), also known as an **exponential Brownian motion**, is a continuous-time [stochastic process](https://en.wikipedia.org/wiki/Stochastic_process "Stochastic process") in which the [logarithm](https://en.wikipedia.org/wiki/Logarithm "Logarithm") of the randomly varying quantity follows a [Brownian motion](https://en.wikipedia.org/wiki/Wiener_process "Wiener process") with [drift](https://en.wikipedia.org/wiki/Stochastic_drift "Stochastic drift"). <br/>
*Source: https://en.wikipedia.org/wiki/Geometric_Brownian_motion*

## Model Equation and Parameters
<img width="569" height="113" alt="image" src="https://github.com/user-attachments/assets/e0366be5-efc0-4ae5-973b-63866b3cf8c5" />

- **$S_t$**: The new stock price at the current tick or day.
- **$S_{t-1}$**: The known stock price from the previous tick or day.
- **$\exp()$**: The exponential function ($e^x$). This is crucial because it ensures your stock prices can never drop below zero, which is a fundamental rule of real-world stock markets.
- **$\mu$ (Drift)**: The expected baseline growth rate. If you set $\mu = 0.05$, the stock has a fundamental underlying drive to grow by 5% over the given time horizon.
- **$\sigma$ (Volatility)**: The intensity of the market noise. Higher $\sigma$ means wider swings and more risk.
- **$\Delta t$ (Time Step)**: The fraction of time that has passed between $S_{t-1}$ and $S_t$. If you are simulating daily steps over a 252-day trading year, $\Delta t = 1/252$. For minute-by-minute ticks, $\Delta t = 1/(252 \times 390)$. But since we need to calculate the candle-stick data for each second we will use  $\Delta t = 1/(907200)$
- **$Z$**: A random number drawn from a standard normal distribution (a bell curve with a mean of 0 and a standard deviation of 1). This is the "roll of the dice" that provides the random daily or minute-by-minute shock to the price.

## How will this work?

So, we have the mathematical equation that we will be using in the engine file. Lets take an example to calculate the stock price for few equations by hand to make the working clear, then you can refer to the engine file to look at the code and see how is the model implemented practically.

##### Example:

let, $S_{t-1}$ = Rs. 690 (This will act as our starting point), $\mu$ (Drift) = 0.25 (This mean annually the stock will grow 25%), $\sigma$ (Volatility) = 0.35 (This is a random value which will act as a basis for adding entropy and realism to the market engine generation), $\Delta t$ (Time Step) = 1/907200 (Since we are calculating price at each second), Z = a random number between [-1,1] that will generated each second for shock factor.
![Calcs](https://github.com/user-attachments/assets/3099d444-9424-4c29-a3a1-68a56d8f1786)

## News Data and Directed Impacts

A story lists the stocks it moves. Each one has an **impact** (a percentage, -50 to +50) and a **time to full effect** (1 second to 2 hours). A stock left on "Default" uses the story's default duration, which is 60 seconds unless the admin changes it. They are stored in `news.affected_stocks` as `{"<stock id>": {"impact_pct", "duration_seconds"}}` and the default in `news.impact_duration_seconds`. Older rows in the `{"SYMBOL": pct}` form are still read.

**Release.** A story goes out when an admin releases it, or when its `release_at` passes: `releaseDueNews` checks every 2 seconds. `releaseNews` in `controller/news.ts` flips the row and stamps `first_released_at` in one locked statement, so an impact is applied **exactly once**. Hiding a story and showing it again does not move prices a second time, and once a story is out its impacts can no longer be edited.

**Pricing in.** On first release the controller emits `newsImpactReleased` with the resolved impacts. The engine queues each impact for the stock's next tick and moves the log price by `ln(1 + pct/100)` along a front-loaded curve, `(1 - e^(-4x)) / (1 - e^(-4))`, where `x` is the share of the duration that has elapsed. About 65% of the move lands in the first quarter of the duration, 88% by half way, and exactly 100% at the end. This sits on top of the normal GBM noise, so the stock ends about `pct` away from where the market alone would have taken it. A new story also doubles the stock's volatility, which fades with the regime half-life. Several stories on one stock add up.

Impacts advance one step per tick, so they pause with the market: a story released while the market is paused starts moving prices when it reopens. The engine keeps them in memory, and on boot `resumeNewsImpacts` hands back whatever part of a recent story is still due, judged by wall-clock time since release.

Players only receive `id`, `title`, `content` and `release_at`. Impacts never leave the admin API.

## Market State: Pause and Sentiment

The `market` table holds a single row (`id = 1`) with the global state of the simulation, editable by admins from the admin panel. The engine reads this row on every tick through a cached accessor, so the switch costs no extra database round trips.

**Pause.** While `is_paused` is true the simulator returns immediately: no ticks are generated, no prices are emitted over the socket, and no OHLC rows are written. Candle timestamps are derived from the previous candle rather than from the wall clock, so the simulated clock simply resumes where it left off. News impacts advance per tick, so they wait out the pause and carry on when the market resumes.

**Sentiment.** The `sentiment` column (`bullish`, `bearish` or `neutral`) acts on every stock in two parts, both measured in the stock's own hourly standard deviation (σ<sub>h</sub>, about 2.4% for a typical large cap) so it shows on calm and volatile stocks alike, and both eased in with a two minute time constant:

- **Repricing.** When the sentiment changes, every stock is repriced 2 σ<sub>h</sub> in the *new* sentiment's direction (about 5% for a large cap, 3% for a calm name, 9% for a volatile one). Two thirds of it lands within two minutes, so the move builds on the chart instead of gapping in one candle. This is what makes the market visibly react: a drift alone grows with time while the noise grows with its square root, so on its own it takes the best part of an hour to show. The repricing is one-way — neutral owes none — so it is never handed back.
- **Drift.** While the sentiment holds, every stock is tilted by 5 σ<sub>h</sub> per hour, so the trend carries on rather than stopping where the repricing left off. A large cap is about +2% into a boom after a minute, +5% after five and +18% after an hour; a crash is about −2%, −5% and −15%. Left on for a whole session it compounds to several times the starting price, so it is meant to be switched back once the move has landed.

Five minutes of pure noise is worth about ±0.7% to a large cap, so a sentiment move of several percent puts the whole board on the same side at once and cannot be mistaken for a quiet afternoon. Simulated on the seeded stocks, a few minutes after switching to bullish about nine stocks in ten are up and the index is up in almost every run, and it stays that way an hour in.

Setting neutral removes the tilt and stops the trend, but leaves the move already made standing: prices hold where the sentiment took them rather than unwinding. Any repricing the old sentiment had not finished paying out is dropped, so a boom called off half way stops there instead of carrying on without it. A flip pays the new direction's repricing from wherever the last one left prices, so bullish followed straight by bearish does come back to about where it started. Toggling in and out of a sentiment ratchets prices, which is an admin holding the dial rather than anything a player can do.

The dials are `SENTIMENT_REPRICE_SIGMAS` (how hard a change lands) and `SENTIMENT_SIGMAS_PER_HOUR` (how far it carries) in `stockEngine.ts`.

Both changes are broadcast to every connected client as a `marketStateUpdate` socket event, and the current state is also sent to each client as it connects.
