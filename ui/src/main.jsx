import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import 'uplot/dist/uPlot.min.css';
import './styles.css';

createRoot(document.getElementById('root')).render(<App />);
