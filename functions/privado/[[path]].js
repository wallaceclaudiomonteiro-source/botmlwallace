export async function onRequest(context) {
    const { request, env } = context;
    
    // O Cloudflare pega a senha que o nosso app.js vai mandar no cabeçalho
    const senha = request.headers.get('x-senha-vip');
    
    // Senhas válidas (no futuro, aqui conectaremos ao Supabase para verificar pagamentos)
    const senhasValidas = ['vip123', 'wallace2026'];
    
    if (senhasValidas.includes(senha)) {
        // Se a senha bater, o Cloudflare libera o download do JSON VIP
        return env.ASSETS.fetch(request);
    }
    
    // Se alguém tentar acessar o link direto pelo navegador sem a senha, recebe um bloqueio!
    return new Response(JSON.stringify({ erro: 'Acesso VIP exigido.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
    });
}