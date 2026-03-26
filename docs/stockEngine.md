## What is a GBM model?
A **geometric Brownian motion** (**GBM**), also known as an **exponential Brownian motion**, is a continuous-time [stochastic process](https://en.wikipedia.org/wiki/Stochastic_process "Stochastic process") in which the [logarithm](https://en.wikipedia.org/wiki/Logarithm "Logarithm") of the randomly varying quantity follows a [Brownian motion](https://en.wikipedia.org/wiki/Wiener_process "Wiener process") with [drift](https://en.wikipedia.org/wiki/Stochastic_drift "Stochastic drift").
*Source: https://en.wikipedia.org/wiki/Geometric_Brownian_motion

## Model Equation and Parameters
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
