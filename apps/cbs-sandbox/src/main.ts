import { createSandbox } from "./sandbox.js";

const port = Number(process.env.SANDBOX_PORT ?? 8090);
createSandbox().server.listen(port, () => console.log(`CBS payment sandbox on http://localhost:${port}/sandbox`));
