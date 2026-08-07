import { createRoot } from 'react-dom/client';
import './index.css';
import App from './renderer/App';

const container = document.getElementById('app-root');
if (!container) {
  throw new Error('app-root element not found');
}

createRoot(container).render(<App />);
