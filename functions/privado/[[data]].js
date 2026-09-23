import { jwtVerify, createRemoteJWKSet } from 'jose';

let jwks;

export async function onRequestGet(context) {
  const { request, env, params } = context;

  const segmentos = params.data || [];
  const nomeArquivo = segmentos.join('/');
  if (!nomeArquivo.endsWith('.json')) {
    return new Response('Not found', { status: 404 });
  }

  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return new Response(JSON.stringify({ erro: 'Não autenticado' }), { status: 401 });
  }

  let payload;
  try {
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`));
    }
    const resultado = await jwtVerify(token, jwks);
    payload = resultado.payload;
  } catch (err) {
    return new Response(JSON.stringify({ erro: 'Token inválido ou expirado' }), { status: 401 });
  }

  const userId = payload.sub;
  if (!userId) {
    return new Response(JSON.stringify({ erro: 'Token sem usuário' }), { status: 401 });
  }

  const urlPerfil = `${env.SUPABASE_URL}/rest/v1/perfis?id=eq.${userId}&select=status,teste_expira_em,vip_expira_em`;
  const respPerfil = await fetch(urlPerfil, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`
    }
  });
  const perfis = await respPerfil.json();
  const perfil = perfis[0];

  const agora = new Date();
  const temAcesso = perfil && (
    (perfil.status === 'vip' && perfil.vip_expira_em && new Date(perfil.vip_expira_em) > agora) ||
    (perfil.status === 'teste' && perfil.teste_expira_em && new Date(perfil.teste_expira_em) > agora)
  );

  if (!temAcesso) {
    return new Response(JSON.stringify({ erro: 'Acesso VIP expirado ou inexistente' }), { status: 403 });
  }

  const objeto = await env.DADOS_VIP.get(nomeArquivo);
  if (!objeto) {
    return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(objeto.body, { headers: { 'Content-Type': 'application/json' } });
}