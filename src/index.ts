import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { z } from 'zod';

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

// Cache for model data (refresh every 5 minutes)
let modelCache: any[] = [];
let lastFetch = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function fetchModels(): Promise<any[]> {
  const now = Date.now();
  if (modelCache.length > 0 && now - lastFetch < CACHE_TTL) {
    return modelCache;
  }
  
  const response = await fetch(OPENROUTER_MODELS_URL);
  if (!response.ok) throw new Error(`OpenRouter API error: ${response.status}`);
  
  const data = await response.json();
  modelCache = data.data || data;
  lastFetch = now;
  return modelCache;
}

function parsePrice(pricing: any): number {
  if (!pricing) return 0;
  const prompt = parseFloat(pricing.prompt || '0');
  const completion = parseFloat(pricing.completion || '0');
  return prompt + completion;
}

const agent = await createAgent({
  name: 'ai-model-registry',
  version: '1.0.0',
  description: 'Real-time AI model registry with pricing, capabilities, and comparison. Aggregates data from OpenRouter for 400+ models across providers.',
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// === FREE ENDPOINT: Overview ===
addEntrypoint({
  key: 'overview',
  description: 'Free overview of the AI model registry - total models, providers, categories',
  input: z.object({}),
  price: { amount: 0 },
  handler: async () => {
    const models = await fetchModels();
    
    // Extract unique providers
    const providers = new Set<string>();
    const modalities = new Map<string, number>();
    let freeModels = 0;
    let paidModels = 0;
    let totalContextTokens = 0;
    
    for (const model of models) {
      const provider = model.id?.split('/')[0];
      if (provider) providers.add(provider);
      
      const modality = model.architecture?.modality || 'text->text';
      modalities.set(modality, (modalities.get(modality) || 0) + 1);
      
      const price = parsePrice(model.pricing);
      if (price === 0) freeModels++;
      else paidModels++;
      
      totalContextTokens += model.context_length || 0;
    }
    
    return {
      output: {
        totalModels: models.length,
        providers: Array.from(providers).sort(),
        providerCount: providers.size,
        freeModels,
        paidModels,
        averageContextLength: Math.round(totalContextTokens / models.length),
        modalities: Object.fromEntries(modalities),
        dataSource: 'OpenRouter API (live)',
        fetchedAt: new Date().toISOString(),
        endpoints: {
          free: ['overview'],
          paid: ['lookup', 'search', 'top', 'compare', 'report']
        }
      }
    };
  },
});

// === PAID ENDPOINT 1: Lookup ($0.001) ===
addEntrypoint({
  key: 'lookup',
  description: 'Look up a specific AI model by ID (e.g., "openai/gpt-4o", "anthropic/claude-3.5-sonnet")',
  input: z.object({
    modelId: z.string().describe('Model ID like "openai/gpt-4o" or partial name like "gpt-4o"')
  }),
  price: { amount: 1000 },
  handler: async (ctx) => {
    const models = await fetchModels();
    const query = ctx.input.modelId.toLowerCase();
    
    // Try exact match first
    let model = models.find(m => m.id?.toLowerCase() === query);
    
    // Try partial match
    if (!model) {
      model = models.find(m => 
        m.id?.toLowerCase().includes(query) || 
        m.name?.toLowerCase().includes(query)
      );
    }
    
    if (!model) {
      return { output: { found: false, query, suggestion: 'Try /search endpoint for broader search' } };
    }
    
    return {
      output: {
        found: true,
        model: {
          id: model.id,
          name: model.name,
          description: model.description?.substring(0, 500),
          contextLength: model.context_length,
          architecture: model.architecture,
          pricing: model.pricing,
          provider: model.id?.split('/')[0],
          supportedParameters: model.supported_parameters,
          created: model.created ? new Date(model.created * 1000).toISOString() : null
        }
      }
    };
  },
});

// === PAID ENDPOINT 2: Search ($0.002) ===
addEntrypoint({
  key: 'search',
  description: 'Search AI models by query, filter by modality, context length, or price range',
  input: z.object({
    query: z.string().optional().describe('Search term for model name/description'),
    modality: z.enum(['text', 'image', 'multimodal', 'all']).optional().default('all'),
    minContext: z.number().optional().describe('Minimum context length in tokens'),
    maxPrice: z.number().optional().describe('Maximum price per 1M tokens (prompt + completion)'),
    freeOnly: z.boolean().optional().default(false),
    limit: z.number().optional().default(20)
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const models = await fetchModels();
    const { query, modality, minContext, maxPrice, freeOnly, limit } = ctx.input;
    
    let filtered = models.filter(model => {
      // Query filter
      if (query) {
        const q = query.toLowerCase();
        const matches = 
          model.id?.toLowerCase().includes(q) ||
          model.name?.toLowerCase().includes(q) ||
          model.description?.toLowerCase().includes(q);
        if (!matches) return false;
      }
      
      // Modality filter
      if (modality !== 'all') {
        const arch = model.architecture?.modality || '';
        if (modality === 'multimodal' && !arch.includes('+')) return false;
        if (modality === 'text' && arch.includes('+')) return false;
        if (modality === 'image' && !arch.includes('image')) return false;
      }
      
      // Context filter
      if (minContext && (model.context_length || 0) < minContext) return false;
      
      // Price filter
      const price = parsePrice(model.pricing);
      if (freeOnly && price > 0) return false;
      if (maxPrice !== undefined) {
        const pricePerMillion = price * 1000000;
        if (pricePerMillion > maxPrice) return false;
      }
      
      return true;
    });
    
    // Sort by context length (descending)
    filtered.sort((a, b) => (b.context_length || 0) - (a.context_length || 0));
    
    return {
      output: {
        totalMatches: filtered.length,
        returned: Math.min(filtered.length, limit),
        filters: { query, modality, minContext, maxPrice, freeOnly },
        models: filtered.slice(0, limit).map(m => ({
          id: m.id,
          name: m.name,
          contextLength: m.context_length,
          pricing: m.pricing,
          modality: m.architecture?.modality
        }))
      }
    };
  },
});

// === PAID ENDPOINT 3: Top Models ($0.002) ===
addEntrypoint({
  key: 'top',
  description: 'Get top AI models by metric: cheapest, longest context, newest, or most capable',
  input: z.object({
    metric: z.enum(['cheapest', 'longest-context', 'newest', 'free']).describe('Ranking metric'),
    modality: z.enum(['text', 'multimodal', 'all']).optional().default('all'),
    limit: z.number().optional().default(10)
  }),
  price: { amount: 2000 },
  handler: async (ctx) => {
    const models = await fetchModels();
    const { metric, modality, limit } = ctx.input;
    
    let filtered = models.filter(m => {
      if (modality === 'all') return true;
      const arch = m.architecture?.modality || '';
      if (modality === 'multimodal') return arch.includes('+');
      return !arch.includes('+');
    });
    
    switch (metric) {
      case 'cheapest':
        filtered = filtered.filter(m => parsePrice(m.pricing) > 0);
        filtered.sort((a, b) => parsePrice(a.pricing) - parsePrice(b.pricing));
        break;
      case 'longest-context':
        filtered.sort((a, b) => (b.context_length || 0) - (a.context_length || 0));
        break;
      case 'newest':
        filtered.sort((a, b) => (b.created || 0) - (a.created || 0));
        break;
      case 'free':
        filtered = filtered.filter(m => parsePrice(m.pricing) === 0);
        break;
    }
    
    return {
      output: {
        metric,
        modality,
        count: Math.min(filtered.length, limit),
        models: filtered.slice(0, limit).map((m, i) => ({
          rank: i + 1,
          id: m.id,
          name: m.name,
          contextLength: m.context_length,
          pricing: m.pricing,
          created: m.created ? new Date(m.created * 1000).toISOString() : null
        }))
      }
    };
  },
});

// === PAID ENDPOINT 4: Compare ($0.003) ===
addEntrypoint({
  key: 'compare',
  description: 'Compare multiple AI models side-by-side on pricing, context, and capabilities',
  input: z.object({
    modelIds: z.array(z.string()).min(2).max(5).describe('Array of model IDs to compare')
  }),
  price: { amount: 3000 },
  handler: async (ctx) => {
    const allModels = await fetchModels();
    const { modelIds } = ctx.input;
    
    const found: any[] = [];
    const notFound: string[] = [];
    
    for (const id of modelIds) {
      const q = id.toLowerCase();
      const model = allModels.find(m => 
        m.id?.toLowerCase() === q || 
        m.id?.toLowerCase().includes(q)
      );
      if (model) {
        found.push({
          id: model.id,
          name: model.name,
          provider: model.id?.split('/')[0],
          contextLength: model.context_length,
          pricing: model.pricing,
          modality: model.architecture?.modality,
          inputModalities: model.architecture?.input_modalities,
          supportedParameters: model.supported_parameters?.length || 0
        });
      } else {
        notFound.push(id);
      }
    }
    
    // Calculate comparison insights
    const cheapest = found.length > 0 
      ? found.reduce((a, b) => parsePrice(a.pricing) < parsePrice(b.pricing) ? a : b)
      : null;
    const longestContext = found.length > 0
      ? found.reduce((a, b) => (a.contextLength || 0) > (b.contextLength || 0) ? a : b)
      : null;
    
    return {
      output: {
        compared: found.length,
        notFound,
        models: found,
        insights: {
          cheapest: cheapest?.id,
          longestContext: longestContext?.id,
          longestContextTokens: longestContext?.contextLength
        }
      }
    };
  },
});

// === PAID ENDPOINT 5: Report ($0.005) ===
addEntrypoint({
  key: 'report',
  description: 'Comprehensive report on a model including pricing analysis and similar alternatives',
  input: z.object({
    modelId: z.string().describe('Model ID to analyze')
  }),
  price: { amount: 5000 },
  handler: async (ctx) => {
    const models = await fetchModels();
    const query = ctx.input.modelId.toLowerCase();
    
    const model = models.find(m => 
      m.id?.toLowerCase() === query || 
      m.id?.toLowerCase().includes(query)
    );
    
    if (!model) {
      return { output: { found: false, query } };
    }
    
    const provider = model.id?.split('/')[0];
    const modality = model.architecture?.modality || 'text->text';
    const price = parsePrice(model.pricing);
    
    // Find alternatives: same modality, different provider, similar context
    const alternatives = models
      .filter(m => {
        if (m.id === model.id) return false;
        const mProvider = m.id?.split('/')[0];
        if (mProvider === provider) return false;
        const mModality = m.architecture?.modality || 'text->text';
        if (mModality !== modality) return false;
        return true;
      })
      .map(m => ({
        id: m.id,
        name: m.name,
        contextLength: m.context_length,
        pricing: m.pricing,
        priceDiff: parsePrice(m.pricing) - price
      }))
      .sort((a, b) => Math.abs(a.priceDiff) - Math.abs(b.priceDiff))
      .slice(0, 5);
    
    // Pricing analysis
    const pricePerMillion = price * 1000000;
    const costFor1kRequests = (1000 * 500 * parseFloat(model.pricing?.prompt || '0')) + 
                              (1000 * 500 * parseFloat(model.pricing?.completion || '0'));
    
    return {
      output: {
        found: true,
        model: {
          id: model.id,
          name: model.name,
          description: model.description,
          provider,
          contextLength: model.context_length,
          architecture: model.architecture,
          pricing: model.pricing,
          supportedParameters: model.supported_parameters,
          created: model.created ? new Date(model.created * 1000).toISOString() : null
        },
        pricingAnalysis: {
          promptPerMillion: parseFloat(model.pricing?.prompt || '0') * 1000000,
          completionPerMillion: parseFloat(model.pricing?.completion || '0') * 1000000,
          estimatedCostPer1kRequests: costFor1kRequests.toFixed(4),
          tier: price === 0 ? 'free' : price < 0.000001 ? 'budget' : price < 0.00001 ? 'standard' : 'premium'
        },
        alternatives: alternatives.map(a => ({
          id: a.id,
          name: a.name,
          contextLength: a.contextLength,
          pricing: a.pricing,
          cheaper: a.priceDiff < 0
        })),
        generatedAt: new Date().toISOString()
      }
    };
  },
});

const port = Number(process.env.PORT ?? 3000);
console.log(`AI Model Registry agent running on port ${port}`);

export default { port, fetch: app.fetch };
