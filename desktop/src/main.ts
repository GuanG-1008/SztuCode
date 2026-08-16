import { createApp } from "vue";
import App from "./App.vue";
import "./lilia.css";
import "./kimi.css";
import "./chat.css";
import "./skill-center.css";
import "./timeline.css";
import "./workbench.css";
import "./file-rail.css";
import "./typography.css";
import "./appearance.css";
import "./queue-dock.css";
import { initializeAppearance } from "./services/appearance";

initializeAppearance();

createApp(App).mount("#app");
