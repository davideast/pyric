import { pyric } from "@pyric/cli/vite";

export default {
  plugins: [pyric({ hosted: true })],
  server: { port: 5182, strictPort: true },
};
