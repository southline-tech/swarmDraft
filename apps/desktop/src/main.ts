import { PRODUCT_NAME } from './lib/brand';
import { createApp } from 'vue';
import App from './App.vue';
import './styles/app.css';
import { bootTheme } from './settings/prefs';
import { ensureOverlayLayer } from './overlay/layer';

// The saved theme applies before the first paint; a ?theme= preview param still wins.
bootTheme();
ensureOverlayLayer();
createApp(App).mount('#app');
document.title = PRODUCT_NAME;
