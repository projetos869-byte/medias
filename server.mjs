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
    if (texto.length > 10_000) throw new Error("Requisição muito grande");
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

      return responderJson(response, 200, {
        ok: true,
        resultado: {
          matricula: funcionario.matricula,
          nome: funcionario.nome,
          mensagem: `${funcionario.nome}, seu acesso foi confirmado com segurança.`,
          historico: [],
        },
      });
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
