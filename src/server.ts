import httpServer from "./app.js";
import config from "./config/config.js";

httpServer.listen(config.PORT, () => {
	console.log(`Server is running on port ${config.PORT}`);
});
