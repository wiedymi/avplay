import { h } from 'vue';
import Theme from 'vitepress/theme';
import './style.css';
import VideoPlayerDemo from '../components/VideoPlayerDemo.vue';

export default {
  extends: Theme,
  Layout: () => {
    return h(Theme.Layout, null, {
      // Additional slots if needed
    });
  },
  enhanceApp({ app, router, siteData }) {
    // Register global components
    app.component('VideoPlayerDemo', VideoPlayerDemo);
  }
};