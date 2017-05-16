# # from Tkinter import *
# import cv2
# from PIL import Image, ImageTk

# master = Tk()
# t = 50

# w = Canvas(master, width=800, height=800)
# w.pack()

# arr = np.zeros((800, 800, 3), dtype=np.uint8)
# pil = Image.fromarray(arr)
# img = ImageTk.PhotoImage(pil)

# w.create_image(400, 400, image=img)

# #w.create_line(0, 0, 200, 100)
# #w.create_line(0, 100, 200, 0, fill="red", dash=(4, 4))

# #w.create_rectangle(50, 25, 150, 75, fill="blue")
# #p_curr = PhotoImage(file="/home/sandro/Desktop/Kunov3.gif")
# #p_other = PhotoImage(file="/home/sandro/Desktop/Kunov2.png")
# #img = w.create_image(500, 500, image=p_curr)

# # def swap():
# #     global img, p_curr, p_other
# #     w.delete(img)
# #     p_curr, p_other = (p_other, p_curr)
# #     img = w.create_image(500, 500, image=p_curr)
# #     master.after(t, swap)

# # n = 0
# # def white():
# #     global n, arr, pil, img
# #     arr[n,:,:] = 255
# #     pil = Image.fromarray(arr)
# #     w.delete(img)
# #     img = ImageTk.PhotoImage(pil)
# #     w.create_image(400, 400, image=img)
# #     n = n + 1
# #     master.after(t, white)

# # master.after(t, white)

# x, y = 0, 0
# def start(event):
#     global x, y
#     x = event.x
#     y = event.y

# def drag(event):
#     global arr, pil, img, x, y
#     cv2.line(arr, (x, y), (event.x, event.y), (255, 255, 255))
#     x = event.x
#     y = event.y
#     pil = Image.fromarray(arr)
#     w.delete(img)
#     img = ImageTk.PhotoImage(pil)
#     w.create_image(400, 400, image=img)
    

# w.bind("<Button-1>", start)
# w.bind("<B1-Motion>", drag)
# mainloop()


# from PyQt4 import QtCore, QtGui
# class CameraViewer(QtGui.QMainWindow):
#     def __init__(self):
#         super(CameraViewer, self).__init__()

#         self.imageLabel = QtGui.QLabel()
#         self.imageLabel.setBackgroundRole(QtGui.QPalette.Base)
#         self.imageLabel.setScaledContents(True)

#         self.scrollArea = QtGui.QScrollArea()
#         self.scrollArea.setWidget(self.imageLabel)
#         self.setCentralWidget(self.scrollArea)

#         self.setWindowTitle("Image Viewer")
#         self.resize(640, 480)

#         timer = QtCore.QTimer(self)
#         timer.timeout.connect(self.open)
#         timer.start(33) #30 Hz

#     def open(self):
#         #get data and display


#         arr = np.zeros((480, 640, 3), dtype=np.uint8)
#         pilimg = Image.fromarray(arr)
#         image = PILQT.ImageQt.ImageQt(pilimg)
#         if image.isNull():
#             QtGui.QMessageBox.information(self, "Image Viewer","Cannot load %s." % fileName)
#             return

#         self.imageLabel.setPixmap(QtGui.QPixmap.fromImage(image))
#         self.imageLabel.adjustSize()


# if __name__ == '__main__':
#     import sys
#     app = QtGui.QApplication(sys.argv)
#     CameraViewer = CameraViewer()
#     CameraViewer.show()
#     sys.exit(app.exec_())

import wx
from PIL import Image
import numpy as np
import cv2


SIZE = (1280, 720)

green = np.ones((SIZE[1], SIZE[0], 3), dtype=np.uint8) * np.array((0, 255, 0), dtype=np.uint8)
arr = np.zeros((SIZE[1], SIZE[0], 4), dtype=np.uint8)
pil = Image.fromarray(arr)

def blend_transparent(face_img, overlay_t_img):
    # Split out the transparency mask from the colour info
    overlay_img = overlay_t_img[:,:,:3] # Grab the BRG planes
    overlay_mask = overlay_t_img[:,:,3:]  # And the alpha plane

    return np.where(np.equal(255, overlay_mask), overlay_img, face_img)

def get_image():
    # # Put your code here to return a PIL image from the camera.
    img = blend_transparent(green, arr)
    img = blend_transparent(green, arr)
    pil = Image.fromarray(img)
    #pil = Image.fromarray(arr)
    return pil

def pil_to_wx(image):
    width, height = image.size
    buffer = image.convert('RGB').tobytes()
    bitmap = wx.BitmapFromBuffer(width, height, buffer)
    return bitmap

x = 0
y = 0
lst = []

# class Panel(wx.Panel):
#     def __init__(self, parent):
#         super(Panel, self).__init__(parent, -1)
#         self.SetSize(SIZE)
#         self.SetBackgroundStyle(wx.BG_STYLE_CUSTOM)
#         self.Bind(wx.EVT_PAINT, self.on_paint)
#         self.Bind(wx.EVT_MOTION, self.on_move)
#         self.update()
#     def on_move(self, event):
#         global arr, pil, x, y
#         cv2.line(arr, (x, y), (event.GetX(), event.GetY()), (255, 255, 255))
#         x = event.GetX()
#         y = event.GetY()
#         pil = Image.fromarray(arr)
#         self.update()
#         # global lst
#         # pnt = (event.GetX(), event.GetY())
#         # lst.append(pnt)
#     def update(self):
#         # global arr, pil, x, y, lst
#         # for (xx, yy) in lst:
#         #     cv2.line(arr, (x, y), (xx, yy), (255, 255, 255))
#         #     (x, y) = (xx, yy)
#         # pil = Image.fromarray(arr)
#         # lst = []
#         self.Refresh()
#         self.Update()
#         # wx.CallLater(15, self.update)
#     def create_bitmap(self):
#         image = get_image()
#         bitmap = pil_to_wx(image)
#         return bitmap
#     def on_paint(self, event):
#         bitmap = self.create_bitmap()
#         dc = wx.AutoBufferedPaintDC(self)
#         dc.DrawBitmap(bitmap, 0, 0)

class Panel(wx.Panel):
    def __init__(self, parent):
        super(Panel, self).__init__(parent, -1)
        self.SetSize(SIZE)
        self.SetBackgroundStyle(wx.BG_STYLE_CUSTOM)
        self.Bind(wx.EVT_PAINT, self.on_paint)
        self.Bind(wx.EVT_MOTION, self.on_move)
        self.update()
    def on_move(self, event):
        # global arr, pil, x, y
        # cv2.line(arr, (x, y), (event.GetX(), event.GetY()), (255, 255, 255))
        # x = event.GetX()
        # y = event.GetY()
        # pil = Image.fromarray(arr)
        # self.update()
        global lst
        pnt = (event.GetX(), event.GetY())
        lst.append(pnt)
    def update(self):
        global arr, pil, x, y, lst
        for (xx, yy) in lst:
            cv2.line(arr, (x, y), (xx, yy), (255, 0, 0, 255))
            (x, y) = (xx, yy)
        lst = []
        self.Refresh()
        self.Update()
        wx.CallLater(20, self.update)
    def create_bitmap(self):
        image = get_image()
        bitmap = pil_to_wx(image)
        return bitmap
    def on_paint(self, event):
        bitmap = self.create_bitmap()
        dc = wx.AutoBufferedPaintDC(self)
        dc.DrawBitmap(bitmap, 0, 0)

class Frame(wx.Frame):
    def __init__(self):
        style = wx.DEFAULT_FRAME_STYLE & ~wx.RESIZE_BORDER & ~wx.MAXIMIZE_BOX
        super(Frame, self).__init__(None, -1, 'Camera Viewer', style=style)
        panel = Panel(self)
        self.Fit()

def main():
    app = wx.PySimpleApp()
    frame = Frame()
    frame.Center()
    frame.Show()
    app.MainLoop()

if __name__ == '__main__':
    main()
