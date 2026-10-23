use std::net::TcpListener;
use std::io::{Read, Write};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct Config {
    db_url: String,
    api_key: String,
}

fn main() {
    // SAST: hardcoded secret
    let api_key = "sk-prod-abc123XYZhardcodedapikey";
    let config = Config {
        db_url: String::from("postgres://admin:password123@localhost/db"),
        api_key: api_key.to_string(),
    };

    let listener = TcpListener::bind("0.0.0.0:8080").unwrap();
    println!("Rust service listening on port 8080");

    for stream in listener.incoming() {
        let mut stream = stream.unwrap();
        let mut buffer = [0; 1024];
        stream.read(&mut buffer).unwrap();
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"
        );
        stream.write_all(response.as_bytes()).unwrap();
    }
}
