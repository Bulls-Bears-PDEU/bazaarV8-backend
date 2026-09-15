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

When a `newsReleased` event is triggered, temporary drift modifiers are applied to the Geometric Brownian Motion (GBM) model to simulate the market's reaction to the news. These targeted adjustments are tracked in the `activeImpacts` map, allowing the simulation to momentarily override the base drift ($\mu$) with directional momentum.

Each news event impact runs on a 60-second execution lifecycle. During this brief 60-second window, the modified drift steers the generated stock prices either upwards or downwards, depending on the severity and sentiment of the news. Once the 60 seconds elapse, the impact is removed from the `activeImpacts` map, and the stock's price generation seamlessly returns to its baseline GBM trajectory.

## Market State: Pause and Sentiment

The `market` table holds a single row (`id = 1`) with the global state of the simulation, editable by admins from the admin panel. The engine reads this row on every tick through a cached accessor, so the switch costs no extra database round trips.

**Pause.** While `is_paused` is true the simulator returns immediately: no ticks are generated, no prices are emitted over the socket, and no OHLC rows are written. Candle timestamps are derived from the previous candle rather than from the wall clock, so the simulated clock simply resumes where it left off. Because news impacts expire on wall clock time, the duration of the pause is added back onto every active impact when the market resumes, so a news event cannot silently evaporate while the market is halted.

**Sentiment.** The `sentiment` column (`bullish`, `bearish` or `neutral`) acts on every stock in two parts, both measured in the stock's own hourly standard deviation (σ<sub>h</sub>, about 2.4% for a typical large cap) so it shows on calm and volatile stocks alike, and both eased in with a one minute time constant:

- **Repricing.** When the sentiment changes, every stock moves 0.3 σ<sub>h</sub> in the new direction (about 0.7% for a large cap; a flip from bearish to bullish is twice that). Two thirds of it lands in the first minute. This is what makes the market visibly react: a drift alone grows with time while the noise grows with its square root, so on its own it takes the best part of an hour to show.
- **Drift.** While the sentiment holds, every stock is tilted by 1 σ<sub>h</sub> per hour, so the trend carries on (about +20% over a nine hour session for a large cap).

Simulated on the seeded stocks, a few minutes after switching to bullish about nine stocks in ten are up and the index is up in almost every run, and it stays that way an hour in. Neutral removes the tilt, which reprices stocks back by the same amount. The dials are `SENTIMENT_REPRICE_SIGMAS` and `SENTIMENT_SIGMAS_PER_HOUR` in `stockEngine.ts`.

Both changes are broadcast to every connected client as a `marketStateUpdate` socket event, and the current state is also sent to each client as it connects.
