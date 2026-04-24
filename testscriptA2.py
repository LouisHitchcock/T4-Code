import math
import tkinter as tk


WINDOW_WIDTH = 900
WINDOW_HEIGHT = 600
BG_COLOR = "#08121a"
TEXT = "Hello World"
FONT = ("Arial", 34, "bold")
FRAME_DELAY_MS = 16


class OrbitingHelloWorld:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("testscriptA2")
        self.root.configure(bg=BG_COLOR)
        self.root.resizable(False, False)

        self.canvas = tk.Canvas(
            root,
            width=WINDOW_WIDTH,
            height=WINDOW_HEIGHT,
            bg=BG_COLOR,
            highlightthickness=0,
        )
        self.canvas.pack()

        self.center_x = WINDOW_WIDTH / 2
        self.center_y = WINDOW_HEIGHT / 2
        self.angle = 0.0

        self.ring = self.canvas.create_oval(
            self.center_x - 160,
            self.center_y - 160,
            self.center_x + 160,
            self.center_y + 160,
            outline="#143040",
            width=3,
        )

        self.text_id = self.canvas.create_text(
            self.center_x,
            self.center_y,
            text=TEXT,
            fill="#7df9ff",
            font=FONT,
        )

        self.echo_ids = [
            self.canvas.create_text(
                self.center_x,
                self.center_y,
                text=TEXT,
                fill=color,
                font=FONT,
            )
            for color in ("#12394a", "#1e5a73", "#2d89a6")
        ]

        self.animate()

    def animate(self) -> None:
        self.angle += 0.04
        orbit_x = self.center_x + math.cos(self.angle) * 145
        orbit_y = self.center_y + math.sin(self.angle * 2) * 90

        self.canvas.coords(self.text_id, orbit_x, orbit_y)

        for index, echo_id in enumerate(self.echo_ids, start=1):
            trail_angle = self.angle - index * 0.18
            trail_x = self.center_x + math.cos(trail_angle) * 145
            trail_y = self.center_y + math.sin(trail_angle * 2) * 90
            self.canvas.coords(echo_id, trail_x, trail_y)

        pulse = 2 + (math.sin(self.angle * 3) + 1.0) * 2
        self.canvas.itemconfig(self.ring, width=pulse)

        self.root.after(FRAME_DELAY_MS, self.animate)


def main() -> None:
    root = tk.Tk()
    OrbitingHelloWorld(root)
    root.mainloop()


if __name__ == "__main__":
    main()
