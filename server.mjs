import "dotenv/config";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomBytes } from "node:crypto";
import pg from "pg";
import bcrypt from "bcryptjs";

const { Pool } = pg;
const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error("DATABASE_URL não configurada.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false },
  max: 5,
});
const sessoesAdmin = new Map();
const tentativasLogin = new Map();
const LIMITE_TENTATIVAS = 5;
const TEMPO_BLOQUEIO_MS = 30_000;

function chaveLogin(request, matricula) {
  const encaminhado = String(request.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return `${encaminhado || request.socket.remoteAddress || "desconhecido"}:${matricula}`;
}

function bloqueioLogin(chave) {
  const controle = tentativasLogin.get(chave);
  if (!controle?.bloqueadoAte) return 0;
  const restante = controle.bloqueadoAte - Date.now();
  if (restante <= 0) {
    tentativasLogin.delete(chave);
    return 0;
  }
  return Math.ceil(restante / 1000);
}

function registrarFalha(chave) {
  const controle = tentativasLogin.get(chave) || { erros: 0, bloqueadoAte: 0 };
  controle.erros += 1;
  if (controle.erros >= LIMITE_TENTATIVAS) {
    controle.bloqueadoAte = Date.now() + TEMPO_BLOQUEIO_MS;
  }
  tentativasLogin.set(chave, controle);
  return bloqueioLogin(chave);
}

function cookies(request) {
  return Object.fromEntries(
    String(request.headers.cookie || "").split(";").map(item => item.trim().split("=")).filter(item => item[0]),
  );
}

function sessaoAdmin(request) {
  const token = cookies(request).portal_admin;
  const sessao = token && sessoesAdmin.get(token);
  if (!sessao || sessao.expira < Date.now()) {
    if (token) sessoesAdmin.delete(token);
    return null;
  }
  return sessao;
}

function responderJson(response, status, data) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(data));
}

async function lerJson(request) {
  let texto = "";
  for await (const parte of request) {
    texto += parte;
    if (texto.length > 2_000_000) throw new Error("Requisição muito grande");
  }
  return JSON.parse(texto || "{}");
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

    if (request.method === "GET" && url.pathname === "/health") {
      await pool.query("SELECT 1");
      return responderJson(response, 200, { ok: true });
    }

    if (request.method === "POST" && url.pathname === "/api/login") {
      const body = await lerJson(request);
      const matricula = String(body.matricula ?? "").trim();
      const senha = String(body.senha ?? "").trim();

      if (!matricula || !senha) {
        return responderJson(response, 400, {
          ok: false,
          error: "Informe a matrícula e a senha.",
        });
      }

      const chave = chaveLogin(request, matricula);
      const segundosRestantes = bloqueioLogin(chave);
      if (segundosRestantes) {
        response.setHeader("retry-after", String(segundosRestantes));
        return responderJson(response, 429, {
          ok: false,
          error: `Muitas tentativas incorretas. Aguarde ${segundosRestantes} segundos.`,
          retryAfter: segundosRestantes,
        });
      }

      const adminResultado = await pool.query(
        `SELECT matricula, nome, senha_hash
           FROM administradores
          WHERE matricula = $1
            AND ativo = TRUE
          LIMIT 1`,
        [matricula],
      ).catch(() => ({ rows: [] }));
      const admin = adminResultado.rows[0];
      if (admin && await bcrypt.compare(senha, admin.senha_hash)) {
        tentativasLogin.delete(chave);
        const token = randomBytes(32).toString("hex");
        sessoesAdmin.set(token, { matricula: admin.matricula, expira: Date.now() + 8 * 60 * 60 * 1000 });
        response.setHeader(
          "set-cookie",
          `portal_admin=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`,
        );
        return responderJson(response, 200, {
          ok: true,
          tipo: "admin",
          nome: admin.nome || "Administrador",
        });
      }

      const resultado = await pool.query(
        `SELECT matricula, nome, senha_hash
           FROM funcionarios
          WHERE matricula = $1
          LIMIT 1`,
        [matricula],
      );

      const funcionario = resultado.rows[0];
      if (!funcionario || !await bcrypt.compare(senha, funcionario.senha_hash)) {
        const bloqueadoPor = registrarFalha(chave);
        if (bloqueadoPor) {
          response.setHeader("retry-after", String(bloqueadoPor));
          return responderJson(response, 429, {
            ok: false,
            error: `Limite de tentativas atingido. Aguarde ${bloqueadoPor} segundos.`,
            retryAfter: bloqueadoPor,
          });
        }
        return responderJson(response, 401, {
          ok: false,
          error: "Matrícula ou senha incorreta.",
        });
      }
      tentativasLogin.delete(chave);

      const medias = await pool.query(
        `SELECT mes, valor
           FROM (
             SELECT id, mes_ano AS mes, media_consumo AS valor
               FROM resultados_consumo
              WHERE matricula = $1
              ORDER BY id DESC
              LIMIT 12
           ) ultimos
          ORDER BY id`,
        [matricula],
      ).catch(() => ({ rows: [] }));

      return responderJson(response, 200, {
        ok: true,
        tipo: "funcionario",
        resultado: {
          matricula: funcionario.matricula,
          nome: funcionario.nome,
          mensagem: `${funcionario.nome}, seu acesso foi confirmado com segurança.`,
          historico: medias.rows.map(item => ({
            mes: item.mes,
            valor: Number(item.valor),
          })),
        },
      });
    }

    if (request.method === "POST" && url.pathname === "/api/admin/importar") {
      if (!sessaoAdmin(request)) {
        return responderJson(response, 401, { ok: false, error: "Sessão administrativa expirada." });
      }
      const body = await lerJson(request);
      const medias = Array.isArray(body.medias) ? body.medias : [];
      if (!medias.length || medias.length > 10_000) {
        return responderJson(response, 400, { ok: false, error: "A planilha não contém dados válidos." });
      }

      const client = await pool.connect();
      let importados = 0;
      let ignorados = 0;
      try {
        await client.query("BEGIN");
        await client.query(`
          CREATE TABLE IF NOT EXISTS resultados_consumo (
            id BIGSERIAL PRIMARY KEY,
            matricula TEXT NOT NULL,
            nome TEXT NOT NULL,
            mes_ano TEXT NOT NULL,
            km NUMERIC NOT NULL DEFAULT 0,
            total_consumo NUMERIC NOT NULL DEFAULT 0,
            media_consumo NUMERIC NOT NULL,
            criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (matricula, mes_ano)
          )
        `);
        for (const item of medias) {
          const matricula = String(item.matricula ?? "").trim();
          const nome = String(item.nome ?? "").trim();
          const mes = String(item.mes ?? "").trim();
          const km = Number(item.km);
          const totalCons = Number(item.totalCons);
          const valor = Number(item.valor);
          if (!matricula || !nome || !mes || ![km, totalCons, valor].every(Number.isFinite)) {
            throw new Error("Linha inválida na planilha.");
          }
          const resultado = await client.query(
            `INSERT INTO resultados_consumo
               (matricula, nome, mes_ano, km, total_consumo, media_consumo)
             SELECT $1, $2, $3, $4, $5, $6
              WHERE EXISTS (
                SELECT 1 FROM funcionarios WHERE matricula = $1
              )
             ON CONFLICT (matricula, mes_ano) DO UPDATE SET
               nome = EXCLUDED.nome,
               km = EXCLUDED.km,
               total_consumo = EXCLUDED.total_consumo,
               media_consumo = EXCLUDED.media_consumo,
               criado_em = NOW()`,
            [matricula, nome, mes, km, totalCons, valor],
          );
          if (resultado.rowCount) importados += 1;
          else ignorados += 1;
        }
        if (!importados) {
          throw new Error("Nenhuma matrícula da planilha foi encontrada no cadastro de funcionários.");
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        console.error("Falha na importação:", error);
        return responderJson(response, 400, {
          ok: false,
          error: error instanceof Error ? error.message : "Não foi possível importar a planilha.",
        });
      } finally {
        client.release();
      }
      return responderJson(response, 200, { ok: true, importados, ignorados });
    }

    if (request.method === "POST" && url.pathname === "/api/admin/logout") {
      const token = cookies(request).portal_admin;
      if (token) sessoesAdmin.delete(token);
      response.setHeader("set-cookie", "portal_admin=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0");
      return responderJson(response, 200, { ok: true });
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/visualizar_portal.html")) {
      const html = await readFile(path.join(root, "visualizar_portal.html"));
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      return response.end(html);
    }

    responderJson(response, 404, { ok: false, error: "Página não encontrada." });
  } catch (error) {
    console.error(error);
    responderJson(response, 500, { ok: false, error: "Erro interno do servidor." });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Portal disponível na porta ${port}.`);
});

async function encerrar() {
  server.close();
  await pool.end();
}

process.on("SIGTERM", encerrar);
process.on("SIGINT", encerrar);
