/**
 * CORS 代理服务器
 * 用于在 Chrome 扩展中访问 Ollama API，解决 CORS 问题
 */

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = 11435;
const OLLAMA_URL = 'http://127.0.0.1:11434';

// 启用 CORS - 配置更宽松的设置以支持 Chrome 扩展
app.use(cors({
    origin: '*', // 允许所有来源（Chrome 扩展使用 chrome-extension:// 协议）
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: false
}));

// 显式处理 OPTIONS 预检请求
app.options('*', (req, res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.sendStatus(200);
});

app.use(express.json());

// 代理所有 /api/* 请求到 Ollama
app.all('/api/*', async (req, res) => {
    const path = req.path;
    const url = `${OLLAMA_URL}${path}`;
    const isStreaming = req.body && req.body.stream === true;

    try {
        // 构建请求头，保留原始请求的重要头信息
        const headers = {
            'Content-Type': 'application/json',
        };
        
        // 转发 Authorization 头（如果存在）
        if (req.headers.authorization) {
            headers['Authorization'] = req.headers.authorization;
        }
        
        const options = {
            method: req.method,
            headers: headers,
            body: req.method !== 'GET' && req.body ? JSON.stringify(req.body) : undefined,
        };

        if (isStreaming) {
            // 流式响应
            const response = await fetch(url, options);
            
            if (!response.ok) {
                res.status(response.status).json({ error: response.statusText });
                return;
            }

            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            // 将流式数据转发给客户端
            response.body.pipe(res);
        } else {
            // 非流式响应
            const response = await fetch(url, options);
            const data = await response.json();
            res.status(response.status).json(data);
        }
    } catch (error) {
        console.error('[CORS Proxy] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 健康检查端点
app.get('/health', (req, res) => {
    res.json({ status: 'ok', proxy: 'running', ollama: OLLAMA_URL });
});

app.listen(PORT, () => {
    console.log(`🚀 CORS 代理服务器运行在 http://127.0.0.1:${PORT}`);
    console.log(`📝 请求将转发到 Ollama (${OLLAMA_URL})`);
    console.log(`💡 其他软件可直接使用 11434 (无CORS)`);
    console.log(`\n✅ 现在可以在 Chrome 扩展中使用 http://127.0.0.1:${PORT}/api/generate`);
});




