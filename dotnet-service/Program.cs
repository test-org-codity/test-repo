using Newtonsoft.Json;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using log4net;
using Npgsql;
using System.Data;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

// SAST: hardcoded JWT secret
var jwtSecret = "my-super-secret-jwt-key-12345";

app.MapGet("/users/{id}", async (string id) =>
{
    // SAST: SQL injection
    await using var conn = new NpgsqlConnection("Host=localhost;Database=mydb;Username=postgres;Password=postgres");
    await conn.OpenAsync();
    await using var cmd = conn.CreateCommand();
    cmd.CommandText = $"SELECT * FROM users WHERE id = {id}";
    return await cmd.ExecuteScalarAsync();
});

app.Run();
