import { PRODUCT_NAME } from './lib/brand';
import { createApp } from 'vue';
import App from './App.vue';
import './styles/app.css';

createApp(App).mount('#app');
document.title = PRODUCT_NAME;
