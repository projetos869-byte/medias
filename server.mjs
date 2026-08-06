import "dotenv/config";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

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

      if (!matricula || !/^[a-z0-9]{5}$/i.test(senha)) {
        return responderJson(response, 400, {
          ok: false,
          error: "Informe a matrícula e uma senha alfanumérica de 5 caracteres.",
        });
      }

      const resultado = await pool.query(
        `SELECT matricula, nome
           FROM funcionarios
          WHERE matricula = $1
            AND senha_hash = crypt($2, senha_hash)
          LIMIT 1`,
        [matricula, senha],
      );

      const funcionario = resultado.rows[0];
      if (!funcionario) {
        return responderJson(response, 401, {
          ok: false,
          error: "Matrícula ou senha incorreta.",
        });
      }

      const medias = await pool.query(
        `SELECT mes_ano AS mes, media_consumo AS valor
           FROM resultados_consumo
          WHERE matricula = $1
          ORDER BY id
          LIMIT 12`,
        [matricula],
      ).catch(() => ({ rows: [] }));

      return responderJson(response, 200, {
        ok: true,
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
      const body = await lerJson(request);
      const adminMatricula = String(body.matricula ?? "").trim();
      const adminSenha = String(body.senha ?? "");
      if (
        !process.env.ADMIN_MATRICULA ||
        !process.env.ADMIN_PASSWORD ||
        adminMatricula !== process.env.ADMIN_MATRICULA ||
        adminSenha !== process.env.ADMIN_PASSWORD
      ) {
        return responderJson(response, 401, { ok: false, error: "Acesso administrativo inválido." });
      }

      const medias = Array.isArray(body.medias) ? body.medias : [];
      if (!medias.length || medias.length > 10_000) {
        return responderJson(response, 400, { ok: false, error: "A planilha não contém dados válidos." });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`
          CREATE TABLE IF NOT EXISTS resultados_consumo (
            id BIGSERIAL PRIMARY KEY,
            matricula TEXT NOT NULL REFERENCES funcionarios(matricula) ON DELETE CASCADE,
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
          await client.query(
            `INSERT INTO resultados_consumo
               (matricula, nome, mes_ano, km, total_consumo, media_consumo)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (matricula, mes_ano) DO UPDATE SET
               nome = EXCLUDED.nome,
               km = EXCLUDED.km,
               total_consumo = EXCLUDED.total_consumo,
               media_consumo = EXCLUDED.media_consumo,
               criado_em = NOW()`,
            [matricula, nome, mes, km, totalCons, valor],
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return responderJson(response, 200, { ok: true, importados: medias.length });
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
