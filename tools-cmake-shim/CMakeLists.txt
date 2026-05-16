cmake_minimum_required(VERSION 3.16)
project(gzdoom_host_tools C CXX)
add_subdirectory("${CMAKE_CURRENT_LIST_DIR}/../gzdoom-src/tools/re2c"  re2c)
add_subdirectory("${CMAKE_CURRENT_LIST_DIR}/../gzdoom-src/tools/lemon" lemon)
