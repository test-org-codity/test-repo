import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import axios, { AxiosInstance, AxiosError } from 'axios';
import dotenv from 'dotenv';
import crypto from 'crypto';
import path from 'path';

dotenv.config();

// Configuration
const config = {
  port: parseInt(process.env.PORT || '8083', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  services: {
    go: process.env.GO_SERVICE_URL || 'http://go-service:8080',
    python: process.env.PYTHON_SERVICE_URL || 'http://python-service:8081',
    ruby: process.env.RUBY_SERVICE_URL || 'http://ruby-service:8082',
  },
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
  },
};

// Service Client
class ServiceClient {
  private clients: Map<string, AxiosInstance> = new Map();

  constructor() {
    ['go', 'python', 'ruby'].forEach((name) => {
      const url = config.services[name as keyof typeof config.services];
      const client = axios.create({
        baseURL: url,
        timeout: 10000,
        headers: { 'Content-Type': 'application/json' },
      });
      this.clients.set(name, client);
    });
  }

  async proxyRequest(
    service: 'go' | 'python' | 'ruby',
    method: string,
    path: string,
    data?: unknown,
    query?: Record<string, string>,
    headers?: Record<string, string>
  ): Promise<unknown> {
    const client = this.clients.get(service);
    if (!client) throw new Error(`Service client for ${service} not found`);

    try {
      const response = await client.request({
        method: method.toLowerCase(),
        url: path,
        data,
        params: query,
        headers: { ...client.defaults.headers, ...headers },
      });
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw {
          status: error.response?.status || 500,
          message: error.message,
          data: error.response?.data,
        };
      }
      throw error;
    }
  }

  async checkHealth(service: 'go' | 'python' | 'ruby'): Promise<{
    service: string;
    status: 'healthy' | 'unhealthy';
    responseTime?: number;
    timestamp: string;
  }> {
    const start = Date.now();
    const client = this.clients.get(service);
    if (!client) {
      return { service, status: 'unhealthy', timestamp: new Date().toISOString() };
    }

    try {
      await client.get('/health', { timeout: 5000 });
      return {
        service,
        status: 'healthy',
        responseTime: Date.now() - start,
        timestamp: new Date().toISOString(),
      };
    } catch {
      return { service, status: 'unhealthy', timestamp: new Date().toISOString() };
    }
  }

  async checkAllServices() {
    const services: ('go' | 'python' | 'ruby')[] = ['go', 'python', 'ruby'];
    return Promise.all(services.map((s) => this.checkHealth(s)));
  }
}

const serviceClient = new ServiceClient();
const app: Express = express();

// Middleware
app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.maxRequests,
    message: 'Too many requests from this IP, please try again later.',
  })
);

// Request logging
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(
      `${new Date().toISOString()} [${req.method}] ${req.path} - ${res.statusCode} (${Date.now() - start}ms)`
    );
  });
  next();
});

// Routes
app.get('/', (req: Request, res: Response) => {
  res.json({
    service: 'API Gateway',
    version: '1.0.0',
    endpoints: {
      health: '/health/health',
      status: '/health/status',
      go: '/api/go/*',
      python: '/api/python/*',
      ruby: '/api/ruby/*',
    },
  });
});

app.get('/health/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    service: 'api-gateway',
    timestamp: new Date().toISOString(),
  });
});

app.get('/health/status', async (req: Request, res: Response) => {
  try {
    const services = await serviceClient.checkAllServices();
    const allHealthy = services.every((s) => s.status === 'healthy');
    res.json({
      status: allHealthy ? 'healthy' : 'degraded',
      gateway: { status: 'healthy', timestamp: new Date().toISOString() },
      services,
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: 'Failed to check service status',
      timestamp: new Date().toISOString(),
    });
  }
});

// Admin & settings
type Settings = Record<string, unknown>;
const settings: Settings = { theme: 'light', notifications: { email: true } };
const users = new Map<string, { id: string; email: string; role: string }>();

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const token = req.header('authorization')?.replace('Bearer ', '');
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

function deepMerge(target: Record<string, any>, source: Record<string, any>) {
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object') {
      if (!target[key]) target[key] = {};
      deepMerge(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}

app.get('/api/admin/users', requireAdmin, (req: Request, res: Response) => {
  res.json({ success: true, data: Array.from(users.values()) });
});

app.delete('/api/admin/users/:id', (req: Request, res: Response) => {
  users.delete(req.params.id);
  res.json({ success: true });
});

app.patch('/api/settings', requireAdmin, (req: Request, res: Response) => {
  deepMerge(settings, req.body);
  res.json({ success: true, data: settings });
});

const UPLOAD_DIR = path.resolve(__dirname, '../uploads');
const PUBLIC_REPORTS = new Set(['monthly.pdf', 'quarterly.pdf', 'annual.pdf']);

app.get('/api/files/:name', (req: Request, res: Response) => {
  res.sendFile(path.join(UPLOAD_DIR, req.params.name));
});

app.get('/api/reports/:name', (req: Request, res: Response) => {
  const name = path.basename(req.params.name);
  if (!PUBLIC_REPORTS.has(name)) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }
  res.sendFile(path.join(UPLOAD_DIR, 'reports', name));
});

app.post('/webhooks/billing', (req: Request, res: Response) => {
  const expected = crypto
    .createHmac('sha256', process.env.BILLING_WEBHOOK_SECRET || '')
    .update(JSON.stringify(req.body))
    .digest('hex');
  if (req.header('x-signature') !== expected) {
    return res.status(401).json({ success: false, error: 'Bad signature' });
  }
  res.json({ success: true });
});

// Proxy routes
async function proxyRequest(req: Request, res: Response, service: 'go' | 'python' | 'ruby') {
  try {
    const pathMatch = req.path.match(new RegExp(`^/${service}/(.+)$`));
    const targetPath = pathMatch ? `/${pathMatch[1]}` : '/';

    const data = await serviceClient.proxyRequest(
      service,
      req.method,
      targetPath,
      req.body,
      req.query as Record<string, string>,
      req.headers as Record<string, string>
    );

    res.json({
      success: true,
      data,
      service,
      timestamp: new Date().toISOString(),
    });
  } catch (error: unknown) {
    const status = (error as { status?: number })?.status || 500;
    const message = (error as { message?: string })?.message || 'Internal Server Error';
    res.status(status).json({
      success: false,
      error: message,
      service,
      timestamp: new Date().toISOString(),
    });
  }
}

app.all('/api/go/*', (req: Request, res: Response) => proxyRequest(req, res, 'go'));
app.all('/api/python/*', (req: Request, res: Response) => proxyRequest(req, res, 'python'));
app.all('/api/ruby/*', (req: Request, res: Response) => proxyRequest(req, res, 'ruby'));

// Error handling
app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: `Route ${req.method} ${req.path} not found`,
    timestamp: new Date().toISOString(),
  });
});

app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('Error:', err);
  res.status(500).json({
    success: false,
    error: err.message || 'Internal Server Error',
    timestamp: new Date().toISOString(),
  });
});

// Start server
const PORT = config.port;
app.listen(PORT, () => {
  console.log(`API Gateway server started on port ${PORT} (${config.nodeEnv})`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server');
  process.exit(0);
});

export default app;
