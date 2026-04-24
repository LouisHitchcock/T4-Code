import math
import tkinter as tk


WINDOW_WIDTH = 900
WINDOW_HEIGHT = 600
BG_COLOR = "#0b1020"
TEXT = "Hello World"
FONT = ("Arial", 34, "bold")
FRAME_DELAY_MS = 16
POINT_COUNT = 96


class WaveTrailHelloWorld:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("TestScriptC")
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

        self.phase = 0.0
        self.path_ids = []

        for index in range(POINT_COUNT):
            color = self._point_color(index)
            point_id = self.canvas.create_oval(0, 0, 0, 0, fill=color, outline="")
            self.path_ids.append(point_id)

        self.text_id = self.canvas.create_text(
            WINDOW_WIDTH * 0.15,
            WINDOW_HEIGHT / 2,
            text=TEXT,
            fill="#f8fafc",
            font=FONT,
        )

        self.glow_id = self.canvas.create_text(
            WINDOW_WIDTH * 0.15,
            WINDOW_HEIGHT / 2,
            text=TEXT,
            fill="#38bdf8",
            font=FONT,
        )
        self.canvas.tag_lower(self.glow_id, self.text_id)

        self.animate()

    def _point_color(self, index: int) -> str:
        ratio = index / max(POINT_COUNT - 1, 1)
        red = int(32 + ratio * 60)
        green = int(90 + ratio * 130)
        blue = int(180 + ratio * 60)
        return f"#{red:02x}{green:02x}{blue:02x}"

    def _wave_position(self, offset: float) -> tuple[float, float]:
        progress = (offset % 1.0)
        x = 80 + progress * (WINDOW_WIDTH - 160)
        y = (
            WINDOW_HEIGHT / 2
            + math.sin(progress * math.pi * 4 + self.phase * 2.8) * 120
            + math.sin(progress * math.pi * 9 - self.phase * 1.7) * 35
        )
        return x, y

    def animate(self) -> None:
        self.phase += 0.018

        for index, point_id in enumerate(self.path_ids):
            trail_progress = self.phase - index * 0.012
            x, y = self._wave_position(trail_progress)
            radius = max(2.0, 7.0 - index * 0.045)
            self.canvas.coords(point_id, x - radius, y - radius, x + radius, y + radius)

        head_x, head_y = self._wave_position(self.phase)
        self.canvas.coords(self.text_id, head_x, head_y)
        self.canvas.coords(self.glow_id, head_x + 2, head_y + 2)

        glow_shift = int((math.sin(self.phase * 6) + 1) * 40)
        glow_color = f"#38{160 + glow_shift:02x}ff"
        self.canvas.itemconfig(self.glow_id, fill=glow_color)

        self.root.after(FRAME_DELAY_MS, self.animate)


def main() -> None:
    root = tk.Tk()
    WaveTrailHelloWorld(root)
    root.mainloop()


if __name__ == "__main__":
    main()
