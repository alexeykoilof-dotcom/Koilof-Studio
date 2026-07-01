import socket
import threading
import time
import webbrowser

from app import app


def pick_port(preferred: int = 8765) -> int:
    candidates = [preferred, *range(8766, 8796), 0]
    for port in candidates:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                sock.bind(("127.0.0.1", port))
                return sock.getsockname()[1]
        except OSError:
            continue
    raise RuntimeError("Не нашёл свободный локальный порт для запуска Koilof.")


def wait_for_server(port: int, timeout: float = 10.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.4):
                return True
        except OSError:
            time.sleep(0.15)
    return False


def run_server(port: int) -> None:
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True, use_reloader=False)


def main() -> None:
    port = pick_port()
    url = f"http://127.0.0.1:{port}"
    print(f"Koilof Studio desktop: {url}")
    threading.Thread(target=run_server, args=(port,), daemon=True).start()
    if not wait_for_server(port):
        raise RuntimeError("Не удалось запустить локальный сервер Koilof.")

    try:
        import webview

        window = webview.create_window(
            "Koilof Studio",
            url,
            width=1440,
            height=940,
            min_size=(1180, 760),
            background_color="#161316",
            text_select=True,
        )
        webview.start(debug=False)
    except Exception as exc:
        print("Не удалось открыть desktop-окно WebView.")
        print("Причина:", exc)
        print("Открываю временно в браузере:", url)
        webbrowser.open(url)
        while True:
            time.sleep(1)


if __name__ == "__main__":
    main()
